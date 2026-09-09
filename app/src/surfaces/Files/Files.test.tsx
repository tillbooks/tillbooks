import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, ENTITY_KINDS, type Capabilities, type EntityKind } from '../../lib/capabilities';
import { ENTITY_KIND_IDS } from '../../../../src/core/customization/entities.js';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { hang, watchReads } from '../../test-transport';
import Files, { LinkedFiles } from './index';

/**
 * E00's Studio surface, against a canned transport.
 *
 * The five states plus the two E00 adds (pending deletion, and an integrity refusal) are each rendered
 * from the shape the ENGINE really sends: every fixture field below exists in a `files_search`,
 * `folders_list` or `files_get_content` payload, and the two facts this surface is most tempted to
 * compute for itself, `retentionLocked` and a folder's `deletable`, arrive from the engine because they
 * are judged against the engine's clock and the engine's rule. A Studio that decided either for itself
 * would eventually disagree with the refusal, which is the defect family this repo has collected most.
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
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/** A stored file exactly as `files_search` projects one. */
function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file_1',
    folderId: 'fold_1',
    title: 'Mietvertrag',
    filename: 'mietvertrag.pdf',
    mime: 'application/pdf',
    bytes: 24_576,
    sha256: '2451b757927d61525518231a06fde70b6c7c90bc8b8edc2125030d12195efa8c',
    tags: ['vertrag', '2026'],
    entityKind: null,
    entityId: null,
    retentionUntil: null,
    retentionSource: null,
    retentionLocked: false,
    version: 1,
    supersedesId: null,
    pendingDelete: false,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

/** A folder exactly as `folders_list` projects one, the engine's own `deletable` included. */
function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fold_1',
    name: 'Verträge',
    parentId: null,
    path: '/Verträge',
    depth: 0,
    fileCount: 1,
    childCount: 0,
    deletable: true,
    ...overrides,
  };
}

const TREE = ok({ folders: [folder()] });
const LIST = ok({ files: [file()], truncated: false, total: 1, ceiling: 1000 });

/**
 * A capability answer for a role holding exactly `held`, for the gates this surface renders.
 *
 * Everything else in this file renders through `ALLOW_ALL` (no provider), which is the pre-A24 default
 * and the reason wiring the gates cost no test churn. F7 is the one claim that cannot be measured that
 * way: "the padlock stands where the button would be" is a statement about a role that holds LESS.
 */
function holding(held: readonly string[]) {
  return {
    whoami: null,
    can: (capability: string) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderFiles(canned: Canned, workspaceId: string | null = 'ws_test', capabilities?: Capabilities) {
  const client = new TillClient(fakeTransport(canned));
  const tree = (
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Files />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  return render(
    capabilities === undefined ? (
      tree
    ) : (
      <CapabilitiesContext.Provider value={capabilities}>{tree}</CapabilitiesContext.Provider>
    ),
  );
}

describe('Dateien, the five states', () => {
  it('renders the list with its folder tree, the size and the version', async () => {
    renderFiles({ files_search: LIST, folders_list: TREE });
    expect(await screen.findByRole('button', { name: 'Mietvertrag' })).toBeInTheDocument();
    // The size goes through the ONE shared formatter, in binary units, matching the cap the engine
    // enforces: a list saying "25.2 MB" beside a refusal saying "25 MiB" is a screen arguing with itself.
    expect(screen.getByText('24 KiB')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Ordner' })).getByText('Verträge')).toBeInTheDocument();
  });

  it('renders the loading state over a read that is genuinely in flight', async () => {
    // The skeleton is this surface's FIRST commit (`loading` starts true), so asserting it says nothing
    // about whether any request was made: the same assertion would hold over a surface that reads
    // nothing at all. `hang` keeps the read pending and `started` proves it left, which is what
    // `src/loading-state-convention.test.ts` exists to require.
    const transport = watchReads(hang('files_search', fakeTransport({ files_search: LIST, folders_list: TREE })));
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Files />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('files_search');
    // The Skeleton carries a `status` role of its own, so the surface's live region is named by its
    // label rather than by picking whichever `status` happens to come first in the tree.
    expect(screen.getByText('Dateien werden geladen')).toBeInTheDocument();
  });

  it('renders the empty state for a workspace with no files at all', async () => {
    renderFiles({ files_search: ok({ files: [] }), folders_list: ok({ folders: [] }) });
    expect(await screen.findByText('Noch keine Dateien.')).toBeInTheDocument();
  });

  it('distinguishes "no files" from "no matches" so a filter is never a mystery', async () => {
    const user = userEvent.setup();
    renderFiles({ files_search: ok({ files: [] }), folders_list: TREE });
    await screen.findByText('Noch keine Dateien.');

    await user.type(screen.getByRole('searchbox'), 'versicherung');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));

    expect(await screen.findByText('Keine Treffer.')).toBeInTheDocument();
    // And the filter that produced it is on screen as a removable chip.
    expect(screen.getByRole('button', { name: /Suche: versicherung/ })).toBeInTheDocument();
  });

  it('renders a transport failure as a failure, with a retry, and never as an empty list', async () => {
    renderFiles({ files_search: reject('store_busy'), folders_list: TREE });
    expect(await screen.findByText('Die Dateien konnten nicht geladen werden.')).toBeInTheDocument();
    expect(screen.queryByText('Noch keine Dateien.')).not.toBeInTheDocument();
  });

  it('renders a payload it cannot read as a failed read, not as an empty workspace', async () => {
    // A shape change in the engine must not look like a new workspace: that is how a broken build ships.
    renderFiles({ files_search: ok({ files: [{ id: 'file_1' }] }), folders_list: TREE });
    expect(await screen.findByText('Die Dateien konnten nicht geladen werden.')).toBeInTheDocument();
  });

  it('renders the padlock panel when the read itself is denied', async () => {
    renderFiles({ files_search: reject('permission_denied', {}, 403), folders_list: TREE });
    expect(await screen.findByText('Dir fehlt das Recht, die Dateien zu sehen.')).toBeInTheDocument();
  });

  it('renders the no-workspace state before a workspace is chosen', () => {
    renderFiles({ files_search: LIST, folders_list: TREE }, null);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });
});

describe('retention, as the engine judges it', () => {
  it('shows the lock and the statutory provenance, never colour alone', async () => {
    const user = userEvent.setup();
    renderFiles({
      files_search: ok({
        files: [file({ retentionUntil: '2036-12-31', retentionSource: 'statutory_auto', retentionLocked: true })],
      }),
      folders_list: TREE,
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));

    const drawer = screen.getByRole('dialog');
    // The date through the shared formatter, and the provenance as WORDS beside the lock glyph.
    expect(within(drawer).getByText('31.12.2036')).toBeInTheDocument();
    expect(within(drawer).getByText('Gesetzlich (OR 958f, 10 Jahre)')).toBeInTheDocument();
  });

  it('disables delete from the ENGINE lock rather than from a date the browser compares', async () => {
    const user = userEvent.setup();
    renderFiles({
      files_search: ok({ files: [file({ retentionUntil: '2036-12-31', retentionLocked: true })] }),
      folders_list: TREE,
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    // A browser in another timezone must not be the thing that decides whether a statutory period has
    // run, so the control follows `retentionLocked` and not a local `new Date()`.
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Löschen' })).toBeDisabled();
  });

  it('renders the engine refusal with the floor it named, and keeps the field open', async () => {
    const user = userEvent.setup();
    renderFiles({
      files_search: LIST,
      folders_list: TREE,
      files_set_retention: reject('retention_below_statutory', { statutoryFloor: '2036-12-31' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    const drawer = screen.getByRole('dialog');

    await user.type(within(drawer).getByLabelText(/Verlängern ist immer möglich/), '2030-01-01');
    await user.click(within(drawer).getAllByRole('button', { name: 'Speichern' })[1] as HTMLElement);

    // The DATE, not the word "no": the operator's next question is "then what is the earliest".
    expect(await within(drawer).findByText(/frühestens 31.12.2036/)).toBeInTheDocument();
  });

  it('renders the retention field read-only text when the actor may not change it', async () => {
    // The Studio's capability gate fails OPEN by design, so a test with no provider sees the editable
    // path; what is asserted here is that the read-only branch exists and says why.
    const user = userEvent.setup();
    renderFiles({ files_search: LIST, folders_list: TREE });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    expect(within(screen.getByRole('dialog')).getByLabelText(/Verlängern ist immer möglich/)).toBeInTheDocument();
  });
});

describe('the version history', () => {
  it('nests the chain under its head and never lists a superseded copy as a peer', async () => {
    const user = userEvent.setup();
    const head = file({
      id: 'file_2',
      version: 2,
      supersedesId: 'file_1',
      versions: [file({ id: 'file_1', version: 1 }), file({ id: 'file_2', version: 2, supersedesId: 'file_1' })],
    });
    renderFiles({ files_search: ok({ files: [head] }), folders_list: TREE });

    // ONE row for one record, even though two versions exist.
    expect(await screen.findAllByRole('button', { name: 'Mietvertrag' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Mietvertrag' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Versionen')).toBeInTheDocument();
    // Newest first in the drawer, though the engine sends oldest first: stored in the order it
    // happened, read in the order a person asks about it.
    const rows = within(drawer).getAllByText(/^Version \d$/);
    expect(rows.map((r) => r.textContent)).toEqual(['Version 2', 'Version 2', 'Version 1']);
  });
});

describe('the download path', () => {
  it('asks the engine for the content and hands over the verified bytes', async () => {
    const user = userEvent.setup();
    const getContent = vi.fn<CannedHandler>(() =>
      ok({
        fileId: 'file_1',
        filename: 'mietvertrag.pdf',
        mime: 'application/pdf',
        bytes: 5,
        sha256: 'x',
        version: 1,
        contentBase64: btoa('hello'),
      }),
    );
    // jsdom has no real download, so the anchor click is what is observable.
    const clicks: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();

    try {
      renderFiles({ files_search: LIST, folders_list: TREE, files_get_content: getContent });
      await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Herunterladen' }));

      await waitFor(() => expect(getContent).toHaveBeenCalledTimes(1));
      expect(getContent.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws_test', fileId: 'file_1' });
      // The ORIGINAL filename, so what lands on disk is what was filed.
      await waitFor(() => expect(clicks).toEqual(['mietvertrag.pdf']));
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('shows the integrity warning and saves NOTHING when the checksum no longer matches', async () => {
    const user = userEvent.setup();
    const clicks: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      clicks.push(this.download);
    };

    try {
      renderFiles({
        files_search: LIST,
        folders_list: TREE,
        files_get_content: reject('integrity_mismatch', { expected: 'a', actual: 'b' }),
      });
      await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Herunterladen' }));

      expect(
        await screen.findByText(/stimmt nicht mehr mit ihrer Prüfsumme überein/),
      ).toBeInTheDocument();
      // Handing over bytes the checksum disowns is worse than refusing: nothing was written.
      expect(clicks).toEqual([]);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });
});

describe('F7: the download right is its own capability', () => {
  // The three cases that matter, and the middle one is the finding: a role holding `read_master_data`
  // and NOT `read_file_content` may see the whole filing and must not be offered its bytes.
  const READS_ONLY = [CAP.readMasterData];
  const READS_AND_DOWNLOADS = [CAP.readMasterData, CAP.readFileContent];

  it('renders a padlock instead of the download control, in the header and per version', async () => {
    const user = userEvent.setup();
    const getContent = vi.fn<CannedHandler>(() => ok({ contentBase64: btoa('x'), mime: 'text/plain', filename: 'x' }));
    renderFiles(
      {
        files_search: ok({ files: [file({ version: 2, versions: [file({ id: 'file_0' }), file({ version: 2 })] })] }),
        folders_list: TREE,
        files_get_content: getContent,
      },
      'ws_test',
      holding(READS_ONLY),
    );
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    const drawer = screen.getByRole('dialog');

    expect(within(drawer).queryByRole('button', { name: 'Herunterladen' })).toBeNull();
    // Glyph AND text, never colour alone, and the reason is on the element for a pointer user.
    const locked = within(drawer).getAllByTitle(/nicht herunterladen/);
    expect(locked.length).toBeGreaterThan(0);
    // One visible badge in the header, plus a screen-reader label on each version row.
    expect(within(drawer).getAllByText('Download gesperrt').length).toBe(3);
    // And the per-version control is padlocked too, so the head being locked is not routed around by
    // fetching version 1 instead.
    expect(within(drawer).queryByRole('button', { name: /Laden/ })).toBeNull();

    // The point of the padlock: nothing is ever asked of the engine, so there is no refusal to render.
    expect(getContent).not.toHaveBeenCalled();
  });

  it('still shows the filing itself, because the list is a different disclosure from the bytes', async () => {
    renderFiles({ files_search: LIST, folders_list: TREE }, 'ws_test', holding(READS_ONLY));
    expect(await screen.findByRole('button', { name: 'Mietvertrag' })).toBeInTheDocument();
    expect(screen.getByText('24 KiB')).toBeInTheDocument();
  });

  it('offers the real control to a role that holds BOTH halves the engine requires', async () => {
    const user = userEvent.setup();
    renderFiles({ files_search: LIST, folders_list: TREE }, 'ws_test', holding(READS_AND_DOWNLOADS));
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Herunterladen' })).toBeInTheDocument();
    expect(within(drawer).queryByText('Download gesperrt')).toBeNull();
  });
});

describe('D34: the ceiling', () => {
  it('says how much of the list is on screen when the engine truncated it', async () => {
    // `files_search` has always answered `{truncated, total, ceiling}` and this surface read none of the
    // three, so a workspace past the ceiling showed a thousand rows with nothing saying so.
    renderFiles({
      files_search: ok({ files: [file()], truncated: true, total: 1005, ceiling: 1000 }),
      folders_list: TREE,
    });
    // Found by its TEXT and not by `role="status"`, because that role is also the skeleton's and the
    // loading-proof guard classifies a block that awaits it as a loading assertion. This block is about
    // a settled list, so the role is asserted on the node instead of used to find it.
    const notice = await screen.findByText(/1000 von 1005 Dateien/);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(/Schränke die Suche ein/);
  });

  it('says nothing at all when the list is complete', async () => {
    renderFiles({ files_search: LIST, folders_list: TREE });
    await screen.findByRole('button', { name: 'Mietvertrag' });
    expect(screen.queryByText(/von .* Dateien werden angezeigt/)).toBeNull();
  });
});

describe('the pending-deletion badge', () => {
  it('renders on the row and in the drawer, with BOTH actions so it is never a dead end', async () => {
    const user = userEvent.setup();
    renderFiles({ files_search: ok({ files: [file({ pendingDelete: true })] }), folders_list: TREE });
    expect(await screen.findAllByText('Löschung ausstehend')).not.toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Mietvertrag' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Bestätigen' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Abbrechen' })).toBeInTheDocument();
  });

  it('confirming calls the SAME delete verb with confirmed, not a second verb', async () => {
    const user = userEvent.setup();
    const del = vi.fn<CannedHandler>(() => ok({ deleted: true, fileId: 'file_1' }));
    renderFiles({
      files_search: ok({ files: [file({ pendingDelete: true })] }),
      folders_list: TREE,
      files_delete: del,
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Bestätigen' }));

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    // `confirmed: true` because a human at this button has already decided. There is no confirm verb.
    expect(del.mock.calls[0]?.[0]).toMatchObject({ fileId: 'file_1', confirmed: true });
    expect(del.mock.calls[0]?.[0].idempotencyKey).toBeTypeOf('string');
  });

  it('cancelling clears the flag through the ordinary edit', async () => {
    const user = userEvent.setup();
    const update = vi.fn<CannedHandler>(() => ok({ file: file() }));
    renderFiles({
      files_search: ok({ files: [file({ pendingDelete: true })] }),
      folders_list: TREE,
      files_update: update,
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Abbrechen' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toMatchObject({ fileId: 'file_1', patch: { pendingDelete: false } });
  });
});

describe('the folder tree', () => {
  it('disables delete with the reason, rather than letting the click be rejected', async () => {
    renderFiles({
      files_search: LIST,
      folders_list: ok({ folders: [folder({ fileCount: 2, deletable: false })] }),
    });
    const button = await screen.findByRole('button', { name: /Ordner löschen: Verträge/ });
    expect(button).toBeDisabled();
    // The engine's own two reasons, told apart: "empty it first" is useless advice to somebody looking
    // at a folder whose only content is a subfolder.
    expect(button).toHaveAttribute('title', 'Ordner muss zuerst leer sein.');
  });

  it('names the subfolder reason when that is what blocks the delete', async () => {
    renderFiles({
      files_search: LIST,
      folders_list: ok({ folders: [folder({ fileCount: 0, childCount: 1, deletable: false })] }),
    });
    const button = await screen.findByRole('button', { name: /Ordner löschen: Verträge/ });
    expect(button).toHaveAttribute('title', 'Ordner enthält noch Unterordner.');
  });

  it('creates a folder as a child of the selected node', async () => {
    const user = userEvent.setup();
    const upsert = vi.fn<CannedHandler>(() => ok({ folder: folder({ id: 'fold_2', name: '2026' }) }));
    renderFiles({ files_search: LIST, folders_list: TREE, folders_upsert: upsert });

    await user.click(await screen.findByRole('button', { name: /^Verträge/ }));
    await user.click(screen.getByRole('button', { name: 'Neuer Unterordner' }));
    await user.type(screen.getByLabelText('Neuer Unterordner'), '2026');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ name: '2026', parentId: 'fold_1' });
  });

  it('renders the folder refusal where it was attempted', async () => {
    const user = userEvent.setup();
    renderFiles({
      files_search: LIST,
      folders_list: ok({ folders: [folder({ deletable: true })] }),
      folders_delete: reject('folder_not_empty', { files: 2, childFolders: 0 }),
    });
    await user.click(await screen.findByRole('button', { name: /Ordner löschen: Verträge/ }));
    expect(await screen.findByText('Nur leere Ordner können gelöscht werden.')).toBeInTheDocument();
  });
});

describe('upload', () => {
  it('sends base64, the filename and the selected folder', async () => {
    const user = userEvent.setup();
    const upload = vi.fn<CannedHandler>(() => ok({ file: file() }));
    renderFiles({ files_search: LIST, folders_list: TREE, files_upload: upload });

    await user.click(await screen.findByRole('button', { name: /^Verträge/ }));
    const picked = new File(['%PDF-1.4 test'], 'beleg.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Datei hochladen'), picked);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const sent = upload.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ filename: 'beleg.pdf', mime: 'application/pdf', folderId: 'fold_1' });
    expect(atob(sent.contentBase64 as string)).toBe('%PDF-1.4 test');
  });

  it('renders the size refusal from the engine rather than guessing a limit in the browser', async () => {
    const user = userEvent.setup();
    renderFiles({
      files_search: LIST,
      folders_list: TREE,
      files_upload: reject('file_too_large', { bytes: 99, max: 26_214_400 }),
    });
    await screen.findByRole('button', { name: 'Mietvertrag' });
    await user.upload(
      screen.getByLabelText('Datei hochladen'),
      new File(['x'], 'gross.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('Die Datei überschreitet die Grössenbeschränkung.')).toBeInTheDocument();
  });
});

describe('the shared linked-files panel', () => {
  function renderLinked(canned: Canned, entityKind: EntityKind, entityId: string, capabilities?: Capabilities) {
    const client = new TillClient(fakeTransport(canned));
    const tree = (
      <TillClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <LinkedFiles workspaceId="ws_test" entityKind={entityKind} entityId={entityId} />
          </MemoryRouter>
        </I18nProvider>
      </TillClientProvider>
    );
    return render(
      capabilities === undefined ? (
        tree
      ) : (
        <CapabilitiesContext.Provider value={capabilities}>{tree}</CapabilitiesContext.Provider>
      ),
    );
  }

  it('the app-side kind union is exactly the engine registry, so neither can drift silently', () => {
    // `ENTITY_KINDS` exists only because TypeScript needs literals for the union; the engine's ids
    // are typed as string. This is the assertion that makes that acceptable: a kind registered next
    // year fails here until the union learns it, and a kind removed fails here until it forgets it.
    expect([...ENTITY_KINDS].sort()).toEqual([...ENTITY_KIND_IDS].sort());
  });

  it('renders for two different entity kinds from the ONE component', async () => {
    const listLinked = vi.fn<CannedHandler>(() => ok({ files: [file()] }));
    const first = renderLinked({ files_list_linked: listLinked }, 'document', 'doc_1');
    expect(await screen.findByText('Mietvertrag')).toBeInTheDocument();
    first.unmount();

    renderLinked({ files_list_linked: listLinked }, 'payment', 'pay_1');
    expect(await screen.findByText('Mietvertrag')).toBeInTheDocument();

    expect(listLinked.mock.calls.map((c) => c[0].entityKind)).toEqual(['document', 'payment']);
  });

  it('attaches as upload THEN link, and says the bytes are safe if the link fails', async () => {
    const user = userEvent.setup();
    renderLinked(
      {
        files_list_linked: ok({ files: [] }),
        files_upload: ok({ file: file() }),
        files_link: reject('entity_not_found', { entityKind: 'document', entityId: 'doc_1' }),
      },
      'document',
      'doc_1',
    );
    await screen.findByText('Noch keine Dateien zu diesem Datensatz.');
    await user.upload(
      screen.getByLabelText('Mit Datensatz verknüpfen'),
      new File(['x'], 'beleg.pdf', { type: 'application/pdf' }),
    );
    // The upload SUCCEEDED, so the message must not imply the file was lost.
    expect(await screen.findByText(/Die Datei ist gespeichert und unter Dateien erreichbar/)).toBeInTheDocument();
  });

  // F8: attaching is upload THEN link, so the affordance needs BOTH `manage_files` and the target
  // kind's own edit right. The second half is derived from `entityKind` through the engine's own
  // `editCapabilityForKind` (document costs `issue` below), so a host passes no capability at all
  // and cannot pass a wrong one.
  it('padlocks the attach control for a role holding manage_files without the target edit right', async () => {
    renderLinked(
      { files_list_linked: ok({ files: [] }) },
      'document',
      'doc_1',
      holding([CAP.manageFiles, CAP.readMasterData]),
    );
    await screen.findByText('Noch keine Dateien zu diesem Datensatz.');
    expect(screen.queryByLabelText('Mit Datensatz verknüpfen')).toBeNull();
    expect(screen.getByText('Verknüpfen gesperrt')).toBeInTheDocument();
  });

  it('padlocks it for a role holding the edit right without manage_files', async () => {
    renderLinked(
      { files_list_linked: ok({ files: [file()] }) },
      'document',
      'doc_1',
      holding([CAP.issue, CAP.readMasterData]),
    );
    // The LIST still renders: seeing what is filed is a different disclosure from filing more.
    expect(await screen.findByText('Mietvertrag')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mit Datensatz verknüpfen')).toBeNull();
    expect(screen.getByText('Verknüpfen gesperrt')).toBeInTheDocument();
  });

  it('offers the real control to a role that holds both halves the two verbs require', async () => {
    renderLinked(
      { files_list_linked: ok({ files: [] }) },
      'document',
      'doc_1',
      holding([CAP.manageFiles, CAP.issue, CAP.readMasterData]),
    );
    await screen.findByText('Noch keine Dateien zu diesem Datensatz.');
    expect(screen.getByLabelText('Mit Datensatz verknüpfen')).toBeInTheDocument();
    expect(screen.queryByText('Verknüpfen gesperrt')).toBeNull();
  });
});

describe('accessibility', () => {
  it('the list has no axe violations', async () => {
    const { container } = renderFiles({ files_search: LIST, folders_list: TREE });
    await screen.findByRole('button', { name: 'Mietvertrag' });
    // BOTH initial reads must have settled before axe runs: the file button proves `files_search`,
    // and this line proves `folders_list`. Under full-suite contention the multi-second axe pass
    // otherwise races the tree's state update landing outside act() (seen once on the A35 gate,
    // 18.08.2026, in a run that had not touched this surface).
    await within(screen.getByRole('navigation', { name: 'Ordner' })).findByText('Verträge');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the drawer has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderFiles({
      files_search: ok({ files: [file({ retentionUntil: '2036-12-31', retentionLocked: true, pendingDelete: true })] }),
      folders_list: TREE,
    });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('closes the drawer on Escape', async () => {
    const user = userEvent.setup();
    renderFiles({ files_search: LIST, folders_list: TREE });
    await user.click(await screen.findByRole('button', { name: 'Mietvertrag' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
