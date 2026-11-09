/**
 * G08 §8 component tests for the Diagnostics & feedback panel.
 *
 * The assertions that matter here are the ones a green screenshot cannot make: that the two empty
 * states come from two DISTINCT predicates, that a rejected `set_diagnostics` leaves the switch off,
 * that Clear now cannot fire without a confirmation whose body says reports are kept, that Clear now
 * survives the permission-denied state, and that no row anywhere claims a report was sent.
 *
 * The default locale is de-CH, so the copy asserted below is the German half of spec §6, at the
 * string lengths the layout has to survive (German runs about 30% longer than English).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads, type WatchedTransport } from '../../test-transport';
import { Diagnostics } from './Diagnostics';

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);

const EMPTY_LOG: RestResponse = { status: 200, body: { ok: true, reports: [], folder: '/tmp/till/feedback' } };

/**
 * The client, plus the two seams a test needs to make a claim about the READ rather than the render.
 *
 * `calls` is the argument record (which verb was asked, with what input). `transport.started(...)`
 * is the ordering seam: it resolves only once the panel has really issued an action, so a test
 * asserting the skeleton can say the load is in flight instead of saying the surface mounted.
 */
function makeClient(routes: Record<string, Route>): {
  client: TillClient;
  calls: [string, unknown][];
  transport: WatchedTransport;
} {
  const calls: [string, unknown][] = [];
  const inner: Transport = async (action, input) => {
    calls.push([action, input]);
    const route = routes[action] ?? (action === 'list_feedback' ? EMPTY_LOG : undefined);
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  const transport = watchReads(inner);
  return { client: new TillClient(transport), calls, transport };
}

function renderPanel(client: TillClient, initialId: string | null = 'ws_test') {
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={initialId}>
          <Diagnostics />
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** The engine's `get_diagnostics` shape (`src/core/support/index.ts`). */
function diagnostics(over: Record<string, unknown> = {}): RestResponse {
  return {
    status: 200,
    body: {
      ok: true,
      capture: false,
      configReadable: true,
      entries: [],
      cap: 20,
      journalPath: '/tmp/till/diagnostics.jsonl',
      ...over,
    },
  };
}

/** One redacted entry, in the shape the redactor really emits: no free text, no absolute path. */
const ENTRY = {
  at: '2026-07-24T09:15:00.000Z',
  kind: 'verb_error',
  name: 'TypeError',
  code: 'unexpected_error',
  action: 'post_entry',
  surface: '/documents/:id',
  detailKeys: ['accountId', 'amount'],
  frames: ['src/core/ledger/post.ts:88:12 postEntry'],
};

/**
 * Rows in the shape `list_feedback` REALLY returns.
 *
 * `kind` is the English title `renderReport` wrote into the artifact ("Something is broken"), not
 * the enum member, because the log is the directory and the row is parsed back out of the markdown.
 * This fixture said `bug` until the panel was opened in a browser and rendered English copy in the
 * middle of a German table. A mock can only restate an assumption, so the assumption had to be
 * checked against the running engine.
 */
function reports(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    feedbackId: `fb_${i}`,
    subject: `Bericht ${i}`,
    kind: i % 2 === 0 ? 'Something is broken' : 'An idea',
    at: `2026-07-${String(20 - (i % 19)).padStart(2, '0')}T10:00:00.000Z`,
    path: `/tmp/till/feedback/fb_${i}.md`,
    state: 'prepared',
  }));
}

const CAPTURE_LABEL = 'Fehlerdetails auf diesem Computer aufzeichnen';
const CLEAR = 'Jetzt löschen';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Diagnostics panel: the five states', () => {
  it('renders a skeleton in the journal table shape, never a spinner', async () => {
    const { client, transport } = makeClient({ get_diagnostics: () => new Promise<RestResponse>(() => {}) });
    renderPanel(client);
    // The skeleton is the DEFAULT state, so it proves nothing on its own: `loading` starts true and
    // the shape below is on screen at the first commit. Waiting for the read to have really been
    // issued is what turns the assertions that follow into a claim about a load in flight.
    await transport.started('get_diagnostics');
    const busy = await screen.findAllByRole('status');
    expect(busy.some((node) => node.getAttribute('aria-busy') === 'true')).toBe(true);
    // The shape is the table's own: the real column headers are present while the data is not.
    expect(screen.getByRole('columnheader', { name: 'Code' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Wo' })).toBeInTheDocument();
  });

  it('renders an error banner with a way out when the journal cannot be read', async () => {
    const { client } = makeClient({
      get_diagnostics: {
        status: 422,
        body: { ok: false, error: 'journal_not_readable', path: '/tmp/till/diagnostics.jsonl' },
      },
    });
    renderPanel(client);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('/tmp/till/diagnostics.jsonl');
    // The way out of an unreadable journal is to erase it, and it stays reachable.
    expect(screen.getByRole('button', { name: CLEAR })).toBeEnabled();
  });

  it('renders the padlock without diagnostics.read, and Clear now stays live', async () => {
    const { client, calls } = makeClient({
      get_diagnostics: { status: 403, body: { ok: false, error: 'permission_denied', capability: 'diagnostics.read' } },
      clear_diagnostics: { status: 200, body: { ok: true, entries: [] } },
    });
    renderPanel(client);
    expect(await screen.findByText(/Löschen kannst du sie trotzdem/)).toBeInTheDocument();
    // The switch is absent rather than drawn in a position the refused read cannot confirm.
    expect(screen.queryByLabelText(CAPTURE_LABEL)).toBeNull();

    // Erasing your own data is never a privilege: the confirm path works from inside the padlock.
    await userEvent.click(screen.getByRole('button', { name: CLEAR }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: CLEAR }));
    await waitFor(() => expect(calls.some(([action]) => action === 'clear_diagnostics')).toBe(true));
  });

  it('renders recorded entries as they would be sent, with no raw enum value on screen', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics({ capture: true, entries: [ENTRY] }) });
    renderPanel(client);
    const row = await screen.findByRole('row', { name: /unexpected_error/ });
    expect(within(row).getByText('post_entry')).toBeInTheDocument();
    expect(within(row).getByText('/documents/:id')).toBeInTheDocument();
    expect(within(row).getByText('accountId, amount')).toBeInTheDocument();
    expect(within(row).getByText('src/core/ledger/post.ts:88:12 postEntry')).toBeInTheDocument();
    // The entry kind is humanised; `verb_error` never reaches the screen.
    expect(within(row).getByText('Eine Aktion ist fehlgeschlagen')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('verb_error');
  });
});

describe('Diagnostics panel: the two empty states are two distinct facts', () => {
  it('says TILL is not recording when capture is off', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics({ capture: false, entries: [] }) });
    renderPanel(client);
    expect(await screen.findByText('TILL zeichnet keine Fehlerdetails auf.')).toBeInTheDocument();
    expect(screen.queryByText('Seit dem Einschalten wurden keine Fehler aufgezeichnet.')).toBeNull();
    // The switch is the next action from this state, and it is a real checkbox sitting right there.
    expect(screen.getByLabelText(CAPTURE_LABEL)).not.toBeChecked();
  });

  it('says nothing has been recorded since you turned it on when capture is on', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics({ capture: true, entries: [] }) });
    renderPanel(client);
    expect(await screen.findByText('Seit dem Einschalten wurden keine Fehler aufgezeichnet.')).toBeInTheDocument();
    expect(screen.queryByText('TILL zeichnet keine Fehlerdetails auf.')).toBeNull();
    expect(screen.getByLabelText(CAPTURE_LABEL)).toBeChecked();
  });
});

describe('Diagnostics panel: the opt-in', () => {
  it('is a real labelled checkbox whose hint states the deletion before the click', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics() });
    renderPanel(client);
    const box = await screen.findByLabelText(CAPTURE_LABEL);
    expect(box).toHaveAttribute('type', 'checkbox');
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(hint).toHaveTextContent('Beim Ausschalten wird das bereits Aufgezeichnete gelöscht.');
  });

  it('renders the fixed what-gets-recorded disclosure in the product', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics() });
    renderPanel(client);
    expect(await screen.findByText('Was aufgezeichnet wird')).toBeInTheDocument();
    expect(screen.getByText(/Der Fehlercode, welche Aktion fehlgeschlagen ist/)).toBeInTheDocument();
    expect(screen.getByText(/^Nie: Beträge, Namen, Kontonummern/)).toBeInTheDocument();
    expect(screen.getByText('TILL verschlüsselt diese Dateien nicht. Auf einem Mac schützt FileVault sie.')).toBeInTheDocument();
    expect(screen.getByText(/gehören zu diesem Computerkonto/)).toBeInTheDocument();
    // A capped log that presents as complete is a lie by omission.
    expect(screen.getByText('Die letzten 20 Fehler werden aufbewahrt.')).toBeInTheDocument();
  });

  it('turns capture on through set_diagnostics and re-reads the journal', async () => {
    const { client, calls } = makeClient({
      get_diagnostics: diagnostics(),
      set_diagnostics: { status: 200, body: { ok: true, capture: true } },
    });
    renderPanel(client);
    await userEvent.click(await screen.findByLabelText(CAPTURE_LABEL));
    await waitFor(() => {
      expect(calls).toContainEqual(['set_diagnostics', { workspaceId: 'ws_test', capture: true }]);
    });
  });

  it('leaves the switch OFF and names the path when the config is not writable', async () => {
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      set_diagnostics: {
        status: 422,
        body: { ok: false, error: 'config_not_writable', path: '/tmp/till/config.json' },
      },
    });
    renderPanel(client);
    await userEvent.click(await screen.findByLabelText(CAPTURE_LABEL));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('TILL konnte nicht in /tmp/till/config.json schreiben, daher bleibt die Einstellung aus.');
    // The failure mode of a privacy control is the private one.
    expect(screen.getByLabelText(CAPTURE_LABEL)).not.toBeChecked();
  });

  it('reports a corrupt config as read-as-defaults and left untouched', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics({ configReadable: false }) });
    renderPanel(client);
    expect(await screen.findByText(/Die Datei wurde unverändert gelassen\./)).toBeInTheDocument();
  });
});

describe('Diagnostics panel: Clear now', () => {
  it('does nothing until the confirmation is answered, and says the reports are kept', async () => {
    const { client, calls } = makeClient({
      get_diagnostics: diagnostics({ capture: true, entries: [ENTRY] }),
      clear_diagnostics: { status: 200, body: { ok: true, entries: [] } },
    });
    renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: CLEAR }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Aufgezeichnete Fehler löschen?')).toBeInTheDocument();
    expect(within(dialog).getByText('Damit wird die Fehlerliste gelöscht. Bereits verfasste Berichte bleiben erhalten.')).toBeInTheDocument();
    expect(calls.some(([action]) => action === 'clear_diagnostics')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: CLEAR }));
    await waitFor(() => expect(calls).toContainEqual(['clear_diagnostics', { workspaceId: 'ws_test' }]));
  });

  it('cancels without erasing anything, by button and by Escape', async () => {
    const { client, calls } = makeClient({
      get_diagnostics: diagnostics({ capture: true, entries: [ENTRY] }),
      clear_diagnostics: { status: 200, body: { ok: true, entries: [] } },
    });
    renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: CLEAR }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: CLEAR }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some(([action]) => action === 'clear_diagnostics')).toBe(false);
  });
});

describe('Feedback log: what was written, and what TILL cannot claim', () => {
  it('lists reports newest first as Prepared, and never as sent', async () => {
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      list_feedback: { status: 200, body: { ok: true, reports: reports(3), folder: '/tmp/till/feedback' } },
    });
    const { container } = renderPanel(client);
    // Await a ROW, never the panel title. The title and the honesty line are both on screen from
    // the first commit, in the loading state, so awaiting either resolves before `list_feedback`
    // has answered and every `getBy` after it races the read. That is what went red on Node 20.
    // The title is matched by ROLE because the ready state renders it twice: the panel heading and
    // the table's visually hidden caption. `getByText` finds both and throws.
    expect(await screen.findAllByText('Vorbereitet')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Von dir verfasste Berichte' })).toBeInTheDocument();
    expect(screen.getByText(/kann nicht erkennen, ob du ihn gesendet hast/)).toBeInTheDocument();
    // The honesty rule, asserted rather than trusted: no row anywhere renders a send.
    const rows = screen.getAllByRole('row');
    for (const row of rows) expect(row).not.toHaveTextContent(/gesendet|versendet|\bsent\b/i);
    expect(container.textContent).not.toMatch(/\bsent\b/i);
    // The kind renders in the reader's language. The engine hands back the English title it wrote
    // into the artifact, and English copy in a de-CH table is a defect, not a fallback.
    expect(screen.getAllByText('Etwas funktioniert nicht').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Eine Idee').length).toBeGreaterThan(0);
    expect(screen.queryByText('Something is broken')).toBeNull();
  });

  it('renders the kind in German even if the engine starts returning the enum member', async () => {
    // The engine SHOULD return `bug`; the Studio must not break on the day it does.
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      list_feedback: {
        status: 200,
        body: {
          ok: true,
          reports: [{ ...reports(1)[0], kind: 'bug' }],
          folder: '/tmp/till/feedback',
        },
      },
    });
    renderPanel(client);
    expect(await screen.findByText('Etwas funktioniert nicht')).toBeInTheDocument();
  });

  it('invites the first report when nothing has been written', async () => {
    const { client } = makeClient({ get_diagnostics: diagnostics() });
    renderPanel(client);
    expect(await screen.findByText('Du hast noch keinen Bericht verfasst.')).toBeInTheDocument();
  });

  it('paginates at 20 rows', async () => {
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      list_feedback: { status: 200, body: { ok: true, reports: reports(25), folder: '/tmp/till/feedback' } },
    });
    renderPanel(client);
    expect(await screen.findByText('Berichte 1 bis 20 von 25')).toBeInTheDocument();
    expect(screen.getAllByText('Vorbereitet')).toHaveLength(20);

    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Berichte 21 bis 25 von 25')).toBeInTheDocument();
    expect(screen.getAllByText('Vorbereitet')).toHaveLength(5);
  });

  it('copies a file path and never offers to reveal it in Finder', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      list_feedback: { status: 200, body: { ok: true, reports: reports(1), folder: '/tmp/till/feedback' } },
    });
    const { container } = renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Dateipfad kopieren von Bericht 0' }));
    expect(writeText).toHaveBeenCalledWith('/tmp/till/feedback/fb_0.md');
    expect(await screen.findByText('Dateipfad kopiert.')).toBeInTheDocument();
    // A browser tab cannot reveal a file in Finder, so the panel never says it can. The path itself
    // is on screen, so a machine with no clipboard API is not left at a dead end.
    expect(container.textContent).not.toMatch(/Finder/i);
    expect(screen.getByText('/tmp/till/feedback/fb_0.md')).toBeInTheDocument();
  });

  it('renders the padlock for the report log without diagnostics.read', async () => {
    const { client } = makeClient({
      get_diagnostics: diagnostics(),
      list_feedback: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    renderPanel(client);
    // The REGION exists from the first commit: it is the panel, and it is there in the loading
    // state too. Only the padlock inside it is evidence that `list_feedback` came back 403, so the
    // padlock is what has to be awaited. Scoped with `within`, because the panel above this one
    // reads fine here and its absence of a padlock is half of what this test says.
    const log = await screen.findByRole('region', { name: 'Von dir verfasste Berichte' });
    expect(await within(log).findByRole('note')).toBeInTheDocument();
  });
});

describe('Diagnostics panel: mounting', () => {
  it('renders nothing at all with no workspace selected', () => {
    const { client, calls } = makeClient({ get_diagnostics: diagnostics() });
    const { container } = renderPanel(client, null);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
  });
});

describe('Diagnostics panel: accessibility', () => {
  beforeEach(() => {
    // jsdom applies no stylesheet, so this pins the structural half of the parity gate in both
    // themes; contrast is judged against the tokens by the browser flow, not here.
    document.documentElement.removeAttribute('data-theme');
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`has no axe violations in the ${theme} theme, with data and the confirm open`, async () => {
      document.documentElement.dataset.theme = theme;
      const { client } = makeClient({
        get_diagnostics: diagnostics({ capture: true, entries: [ENTRY] }),
        list_feedback: { status: 200, body: { ok: true, reports: reports(25), folder: '/tmp/till/feedback' } },
      });
      const { container } = renderPanel(client);
      // BOTH reads, because the audit is over the whole container and the test says "with data".
      // Waiting only for the journal row leaves the feedback log free to still be a skeleton, and a
      // green axe run over a skeleton is a green run over the state this test is not about.
      await screen.findByRole('row', { name: /unexpected_error/ });
      await screen.findByText('Berichte 1 bis 20 von 25');
      expect(await axe(container)).toHaveNoViolations();

      await userEvent.click(screen.getByRole('button', { name: CLEAR }));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    });
  }

  it('has no axe violations in the permission-denied state', async () => {
    const { client } = makeClient({
      get_diagnostics: { status: 403, body: { ok: false, error: 'permission_denied' } },
      list_feedback: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    const { container } = renderPanel(client);
    // Both refusals, for the same reason: one padlock on screen and one panel still loading is not
    // the permission-denied state, it is half of it.
    //
    // `waitFor` and not `findAllByRole`, because the two panels read INDEPENDENTLY and resolve in
    // whichever order they resolve. `findAllBy` returns the first non-empty match, which can be one
    // padlock, and `toHaveLength(2)` would then fail without ever retrying: the same defect as the
    // one this commit repairs, one level further in.
    await screen.findByText(/Löschen kannst du sie trotzdem/);
    await waitFor(() => expect(screen.getAllByRole('note')).toHaveLength(2));
    expect(await axe(container)).toHaveNoViolations();
  });
});
