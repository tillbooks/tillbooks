/**
 * M00 first-run flow component test (spec §8): the three doors render; create and restore drive their
 * verbs; a restore rejection renders its remedy (not_a_till_database); the adopt door (D166 point 8)
 * hands the book to the host door with no terminal step and calls NO verb. Rendered in de-CH (the
 * I18nProvider default) unless a test names the locale.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import { STUDIO_ADOPT_PATH, STUDIO_FORGET_PATH, STUDIO_KEY_HEADER, STUDIO_PROVE_PATH, STUDIO_SESSION_STORAGE } from '../../lib/studio-key';
import { FirstRun } from './FirstRun';

type Handler = (input: Record<string, unknown>) => RestResponse;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });
/** F-06: the restore act verifies first; a clean snapshot answer for the tests that drive the restore itself. */
const VERIFIED: RestResponse = ok({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 3, balanceOk: true, format: 'sqlite_snapshot' });

function setup(canned: Record<string, RestResponse | Handler>, opts: { locale?: 'de-CH' | 'en' } = {}) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const inner: Transport = async (action, input) => {
    calls.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
  const transport = watchReads(inner);
  const client = new TillClient(transport);
  render(
    <MemoryRouter>
      <I18nProvider initialLocale={opts.locale ?? 'de-CH'}>
        <TillClientProvider client={client}>
          <WorkspaceProvider initialId={null}>
            <FirstRun />
          </WorkspaceProvider>
        </TillClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  return { calls, transport };
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

  it('D161.2: a restore whose portal links wait for a new hand-over says how many before it leaves', async () => {
    const user = userEvent.setup();
    setup({
      verify_backup: VERIFIED,
      restore_backup: ok({ workspaceId: 'ws_r', portalLinksAwaitingHandover: 2 }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    expect(await screen.findByText(/2 Portal-Links bleiben zu, bis du sie wieder freigibst/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeInTheDocument();
  });

  it('renders the remedy when the restored file is not a TILL database', async () => {
    const user = userEvent.setup();
    setup({ verify_backup: VERIFIED, restore_backup: reject('not_a_till_database'), delivery_status: reject('transport_error', 500) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/nope.bin');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/keine TILL-Datenbank/);
  });

  it('R4-1: a restore saved WHOLE before the book moved on to a newer TILL says so, never "not changed, try again"', async () => {
    const user = userEvent.setup();
    const saved: RestResponse = {
      status: 422,
      body: { ok: false, error: 'schema_newer_than_runtime', bookGeneration: 8, buildGeneration: 7, path: '/x/book.db', partial: true, completed: true },
    };
    setup({ verify_backup: VERIFIED, restore_backup: saved, delivery_status: reject('transport_error', 500) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Diese Aktion ist gespeichert.');
    expect(alert).toHaveTextContent('Wiederhole die Aktion nicht, sonst entsteht sie doppelt.');
    expect(alert).not.toHaveTextContent(/nicht verändert|versuche es erneut/);
  });

  it('R4-1: a newer book refused BEFORE anything was written keeps the first-run sentence', async () => {
    const user = userEvent.setup();
    setup({ verify_backup: VERIFIED, restore_backup: reject('schema_newer_than_runtime'), delivery_status: reject('transport_error', 500) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Datei wurde nicht verändert.');
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

  it('K-05: the lead waits for the list read behind a placeholder, never the premature no-ledger sentence', async () => {
    // The list read never answers: the lead must not claim anything about the device yet.
    const { transport } = setup({
      list_workspaces: (() => new Promise<RestResponse>(() => {})) as unknown as Handler,
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    await transport.started('list_workspaces');
    await screen.findByText(/Läuft als:/);
    expect(screen.queryByText(/kein Hauptbuch gefunden/)).not.toBeInTheDocument();
    expect(screen.queryByText(/bereits/)).not.toBeInTheDocument();
    expect(document.querySelector('.firstrun-intro [aria-busy="true"]')).not.toBeNull();
  });

  it('K-05/K-07: the shared SurfaceHeader names the page, and no MCP verb name is copy', async () => {
    setup({
      list_workspaces: ok({ workspaces: [] }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    const title = await screen.findByRole('heading', { level: 1, name: /Richte dein Hauptbuch ein/ });
    expect(title.closest('.surface-header')).not.toBeNull();
    await screen.findByText(/Läuft als:/);
    expect(document.body.textContent).not.toMatch(/Agent: |create_workspace|restore_backup/);
  });
});

/**
 * D166 point 8 (owner, 14.10.2026): the adopt door works without a terminal. No command block, no
 * environment variable, no "restart it yourself" in either locale; inside TILL.app the native open
 * panel picks the file, in a browser the person names its path; the host door does the rest.
 */
describe('FirstRun, adopting an existing book without a terminal (D166 point 8)', () => {
  const RUNTIME = ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } });
  const TOKEN = 'T'.repeat(43);

  beforeEach(() => {
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    delete (window as unknown as { webkit?: unknown }).webkit;
  });

  /** A fake host: answers the adopt call as told, and the proof as one steady process. */
  function stubHost(adopt: { status: number; body: unknown }, forget: { status: number; body: unknown } = { status: 200, body: { ok: true, restarting: true } }) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === STUDIO_ADOPT_PATH) return new Response(JSON.stringify(adopt.body), { status: adopt.status });
      if (url === STUDIO_FORGET_PATH) return new Response(JSON.stringify(forget.body), { status: forget.status });
      if (url === STUDIO_PROVE_PATH) return new Response(JSON.stringify({ ok: true, proof: 'P'.repeat(43) }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function adoptDoor(): HTMLElement {
    const article = screen.getByRole('heading', { name: /Bestehende Datenbank übernehmen|Adopt an existing database/ }).closest('article');
    if (article === null) throw new Error('the adopt door is not rendered');
    return article;
  }

  for (const locale of ['de-CH', 'en'] as const) {
    it(`names no terminal step in ${locale}: no TILL_DB_PATH, no "till up", no Terminal`, async () => {
      setup({ delivery_status: RUNTIME }, { locale });
      await screen.findByText(/Läuft als:|Running as:/);
      const text = adoptDoor().textContent ?? '';
      expect(text).not.toMatch(/TILL_DB_PATH|till up|Terminal|neu starten|kein Verb|not a verb/i);
      expect(adoptDoor().querySelector('pre, code')).toBeNull();
    });
  }

  it('in a browser, posts the typed path with the Studio credential and shows the opening state', async () => {
    const user = userEvent.setup();
    const fetchMock = stubHost({ status: 200, body: { ok: true, restarting: true } });
    const { calls } = setup({ delivery_status: RUNTIME });
    await screen.findByText(/Läuft als:/);
    await user.type(within(adoptDoor()).getByLabelText(/Pfad zum Hauptbuch/), '/Users/du/Dokumente/till.db');
    await user.click(within(adoptDoor()).getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' })).toBeInTheDocument();
    const adoptCall = fetchMock.mock.calls.find(([url]) => url === STUDIO_ADOPT_PATH);
    expect(adoptCall).toBeDefined();
    const headers = new Headers(adoptCall?.[1]?.headers);
    expect(headers.get(STUDIO_KEY_HEADER)).toBe(TOKEN);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(adoptCall?.[1]?.body))).toEqual({ path: '/Users/du/Dokumente/till.db' });
    // Adoption is host configuration: no verb of the action registry is called for it.
    expect(calls.some((c) => !['list_workspaces', 'list_restorable_backups', 'delivery_status'].includes(c.action))).toBe(false);
  });

  it('inside TILL.app, picks the file through the tillPick bridge, shows its name, and adopts that path', async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn(async (): Promise<unknown> => '/Users/du/Dokumente/Beispiel AG.db');
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { tillPick: { postMessage }, till: { postMessage: vi.fn() } } };
    const fetchMock = stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: RUNTIME });
    await screen.findByText(/Läuft als:/);
    expect(within(adoptDoor()).queryByLabelText(/Pfad zum Hauptbuch/)).toBeNull();
    await user.click(within(adoptDoor()).getByRole('button', { name: 'Datei wählen …' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'pickBook' });
    expect(await within(adoptDoor()).findByText('Gewählt: Beispiel AG.db')).toBeInTheDocument();
    await user.click(within(adoptDoor()).getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' })).toBeInTheDocument();
    const adoptCall = fetchMock.mock.calls.find(([url]) => url === STUDIO_ADOPT_PATH);
    expect(JSON.parse(String(adoptCall?.[1]?.body))).toEqual({ path: '/Users/du/Dokumente/Beispiel AG.db' });
    // The app restarts and reloads its own window: the page asks the host for no proof.
    expect(fetchMock.mock.calls.some(([url]) => url === STUDIO_PROVE_PATH)).toBe(false);
  });

  const REFUSALS: Array<[string, string]> = [
    ['book_path_pinned', 'Diese Installation legt ihr Hauptbuch selbst fest.'],
    ['book_path_not_absolute', 'Gib den vollständigen Pfad an'],
    ['book_not_found', 'Unter diesem Pfad liegt keine Datei.'],
    ['not_a_till_database', 'Diese Datei ist kein TILL-Hauptbuch.'],
    // The shared sentence wins on purpose (refusalText: one sentence per refusal, app-wide).
    ['schema_newer_than_runtime', 'Diese Datenbank wurde von einem neueren TILL geschrieben.'],
    ['book_already_open', 'Dieses Hauptbuch ist bereits geöffnet.'],
    ['book_not_saved', 'TILL konnte sich das Hauptbuch nicht merken.'],
    ['restart_unavailable', 'Diese Installation kann ihr Hauptbuch nicht selbst wechseln.'],
    ['something_unheard_of', 'Das hat nicht geklappt. Es wurde nichts verändert.'],
  ];
  for (const [code, sentence] of REFUSALS) {
    it(`renders its own calm sentence for ${code}, never the raw code, and stays on the doors`, async () => {
      const user = userEvent.setup();
      stubHost({ status: 409, body: { ok: false, error: code } });
      setup({ delivery_status: RUNTIME });
      await screen.findByText(/Läuft als:/);
      await user.type(within(adoptDoor()).getByLabelText(/Pfad zum Hauptbuch/), '/Users/du/till.db');
      await user.click(within(adoptDoor()).getByRole('button', { name: 'Übernehmen' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(sentence);
      expect(alert).not.toHaveTextContent(code);
      expect(screen.queryByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' })).toBeNull();
    });
  }

  it('the adopt door passes axe, in the browser form and in the opening state', async () => {
    const user = userEvent.setup();
    stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: RUNTIME });
    await screen.findByText(/Läuft als:/);
    expect(await axe(adoptDoor())).toHaveNoViolations();
    await user.type(within(adoptDoor()).getByLabelText(/Pfad zum Hauptbuch/), '/Users/du/till.db');
    await user.click(within(adoptDoor()).getByRole('button', { name: 'Übernehmen' }));
    const opening = await screen.findByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' });
    expect(await axe(opening.closest('section') as HTMLElement)).toHaveNoViolations();
  });

  it('L2: the opening state says that connected agents see the new book once they restart', async () => {
    const user = userEvent.setup();
    stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: RUNTIME });
    await screen.findByText(/Läuft als:/);
    await user.type(within(adoptDoor()).getByLabelText(/Pfad zum Hauptbuch/), '/Users/du/till.db');
    await user.click(within(adoptDoor()).getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByText('Agenten, die schon verbunden sind, sehen das neue Hauptbuch, sobald sie neu starten.')).toBeInTheDocument();
  });
});

/**
 * D166 point 8, critic F1/F2: the adopted book is not reachable. `till up` opened nothing in its place
 * (an in-memory book, no cadence) and says so through delivery_status; this page names the book and
 * offers three choices, none of them a terminal step.
 */
describe('FirstRun, the adopted book is not reachable (D166 point 8, critic F1/F2)', () => {
  const TOKEN = 'T'.repeat(43);
  const BOOK = '/Volumes/Archiv/Beispiel AG/till.db';
  const unavailableRuntime = (reason: 'missing' | 'unopenable') =>
    ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null }, adoptedBookUnavailable: { path: BOOK, reason } });

  beforeEach(() => {
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  function stubHost(adopt: { status: number; body: unknown }, forget: { status: number; body: unknown } = { status: 200, body: { ok: true, restarting: true } }) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === STUDIO_ADOPT_PATH) return new Response(JSON.stringify(adopt.body), { status: adopt.status });
      if (url === STUDIO_FORGET_PATH) return new Response(JSON.stringify(forget.body), { status: forget.status });
      if (url === STUDIO_PROVE_PATH) return new Response(JSON.stringify({ ok: true, proof: 'P'.repeat(43) }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const TITLE = 'Dein übernommenes Hauptbuch ist nicht erreichbar';

  it('replaces the doors with one calm page naming the missing book, and no terminal step', async () => {
    setup({ delivery_status: unavailableRuntime('missing') });
    expect(await screen.findByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
    expect(screen.getByText(/TILL findet die Datei nicht mehr: \/Volumes\/Archiv\/Beispiel AG\/till\.db\./)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Neues Hauptbuch anlegen/ })).toBeNull();
    for (const name of ['Erneut versuchen', 'Anderes Hauptbuch wählen', 'Vergessen und neu beginnen']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/TILL_DB_PATH|till up|Terminal/);
  });

  it('critic N1: shows the page even when a workspace is present (the doors never win over it)', async () => {
    setup({
      delivery_status: unavailableRuntime('missing'),
      list_workspaces: ok({ workspaces: [{ workspaceId: 'ws_1', name: 'Beispiel AG', archived: false }] }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Zur Übersicht/ })).toBeNull();
  });

  it('names an unopenable book differently, in English too', async () => {
    setup({ delivery_status: unavailableRuntime('unopenable') }, { locale: 'en' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your adopted book is not reachable' })).toBeInTheDocument();
    expect(screen.getByText(/TILL cannot open the file: \/Volumes\/Archiv\/Beispiel AG\/till\.db\./)).toBeInTheDocument();
  });

  it('"Erneut versuchen" adopts the same book again through the door and shows the opening state', async () => {
    const user = userEvent.setup();
    const fetchMock = stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: unavailableRuntime('missing') });
    await user.click(await screen.findByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => url === STUDIO_ADOPT_PATH);
    expect(new Headers(call?.[1]?.headers).get(STUDIO_KEY_HEADER)).toBe(TOKEN);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ path: BOOK });
  });

  it('"Erneut versuchen" on a book that is still gone says so calmly and stays on the page', async () => {
    const user = userEvent.setup();
    stubHost({ status: 400, body: { ok: false, error: 'book_not_found' } });
    setup({ delivery_status: unavailableRuntime('missing') });
    await user.click(await screen.findByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unter diesem Pfad liegt keine Datei.');
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
  });

  it('"Anderes Hauptbuch wählen" opens the adopt form and adopts the chosen path', async () => {
    const user = userEvent.setup();
    const fetchMock = stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: unavailableRuntime('missing') });
    await user.click(await screen.findByRole('button', { name: 'Anderes Hauptbuch wählen' }));
    await user.type(screen.getByLabelText(/Pfad zum Hauptbuch/), '/Users/du/Dokumente/anderes.db');
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByRole('heading', { name: 'TILL öffnet dein Hauptbuch …' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => url === STUDIO_ADOPT_PATH);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ path: '/Users/du/Dokumente/anderes.db' });
  });

  it('"Vergessen und neu beginnen" asks first; Abbrechen sends nothing, Vergessen posts forget-book with the credential', async () => {
    const user = userEvent.setup();
    const fetchMock = stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: unavailableRuntime('missing') });
    await user.click(await screen.findByRole('button', { name: 'Vergessen und neu beginnen' }));
    expect(screen.getByText(/TILL vergisst nur, wo dieses Hauptbuch liegt/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(fetchMock.mock.calls.some(([url]) => url === STUDIO_FORGET_PATH)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Vergessen und neu beginnen' }));
    await user.click(screen.getByRole('button', { name: 'Vergessen' }));
    expect(await screen.findByRole('heading', { name: 'TILL beginnt neu …' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => url === STUDIO_FORGET_PATH);
    expect(new Headers(call?.[1]?.headers).get(STUDIO_KEY_HEADER)).toBe(TOKEN);
  });

  it('a forget the host could not do is said plainly, and the page stays', async () => {
    const user = userEvent.setup();
    stubHost({ status: 200, body: { ok: true, restarting: true } }, { status: 500, body: { ok: false, error: 'book_not_forgotten' } });
    setup({ delivery_status: unavailableRuntime('missing') });
    await user.click(await screen.findByRole('button', { name: 'Vergessen und neu beginnen' }));
    await user.click(screen.getByRole('button', { name: 'Vergessen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TILL konnte das Hauptbuch nicht vergessen.');
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
  });

  it('the not-reachable page passes axe, with the forget confirmation open', async () => {
    const user = userEvent.setup();
    stubHost({ status: 200, body: { ok: true, restarting: true } });
    setup({ delivery_status: unavailableRuntime('missing') });
    const title = await screen.findByRole('heading', { level: 1, name: TITLE });
    await user.click(screen.getByRole('button', { name: 'Vergessen und neu beginnen' }));
    expect(await axe(title.closest('section') as HTMLElement)).toHaveNoViolations();
  });
});
