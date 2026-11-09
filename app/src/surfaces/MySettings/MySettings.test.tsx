/**
 * D178 point 7, Meine Einstellungen. It renders what the engine's `prefs_list` says, grouped by area; a
 * choice applies at once through `prefs_set`; a row offers its reset once it differs from the default and
 * each group offers a reset of the whole area; the search narrows the rows and its filtered-empty state
 * clears it; a refusal is said in words beside the row and the value goes back. The five states: the
 * skeleton while the read is in flight, the read error with a retry, the empty registry, the groups, the
 * filtered-empty search. SYNTHETIC BY CONSTRUCTION: the catalogue below is invented.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { I18nProvider } from '../../i18n';
import { PrefsProvider, resetPrefsModuleForTests, type PrefView } from '../../lib/prefs';
import { neverSettles, watchReads } from '../../test-transport';
import { MySettings, groupPrefs, prefMatches } from './MySettings';

const T = (en: string, de: string) => ({ en, 'de-CH': de });
const APPEARANCE = { id: 'appearance', label: T('Appearance', 'Darstellung') };
const PROBE = { id: 'probe', label: T('Probe', 'Probe') };

function view(p: Partial<PrefView> & Pick<PrefView, 'key' | 'schema' | 'default' | 'area' | 'label'>): PrefView {
  return {
    value: p.default,
    isDefault: true,
    stale: false,
    scope: 'person',
    description: T('A description.', 'Eine Beschreibung.'),
    valueLabels: null,
    updatedAt: null,
    ...p,
  } as PrefView;
}

const CATALOG: PrefView[] = [
  view({
    key: 'appearance.theme',
    schema: { type: 'enum', values: ['light', 'dark', 'system'] },
    default: 'system',
    area: APPEARANCE,
    label: T('Colour scheme', 'Farbschema'),
    description: T('Light, dark, or the system.', 'Hell, dunkel oder wie dein System.'),
    valueLabels: { light: T('Light', 'Hell'), dark: T('Dark', 'Dunkel'), system: T('Same as system', 'Wie das System') },
  }),
  view({
    key: 'appearance.density',
    schema: { type: 'enum', values: ['komfortabel', 'kompakt'] },
    default: 'komfortabel',
    area: APPEARANCE,
    label: T('Density', 'Dichte'),
    description: T('Room for rows.', 'Raum für Zeilen.'),
    valueLabels: { komfortabel: T('Comfortable', 'Komfortabel'), kompakt: T('Compact', 'Kompakt') },
  }),
  view({ key: 'probe.rows', schema: { type: 'integer', min: 1, max: 50 }, default: 10, area: PROBE, label: T('Rows', 'Zeilen'), scope: 'workspace' }),
  view({ key: 'probe.flag', schema: { type: 'boolean' }, default: false, area: PROBE, label: T('Flag', 'Schalter') }),
  view({
    key: 'probe.order',
    schema: { type: 'json', root: 'array', maxBytes: 256 },
    default: [],
    value: ['b', 'a'],
    isDefault: false,
    area: PROBE,
    label: T('Order', 'Reihenfolge'),
    scope: 'workspace',
  }),
];

type Call = { action: string; input: Record<string, unknown> };

/** A fake engine over a catalogue: it stores what `prefs_set` sends and clears what `prefs_reset` names. */
function engine(catalog: PrefView[] = CATALOG, opts: { refuseSet?: string; failList?: number } = {}) {
  const rows = new Map(catalog.map((p) => [p.key, { ...p }]));
  const calls: Call[] = [];
  let failures = opts.failList ?? 0;
  const transport: Transport = async (action, input): Promise<RestResponse> => {
    calls.push({ action, input });
    if (action === 'prefs_list') {
      if (failures > 0) {
        failures -= 1;
        return { status: 422, body: { ok: false, error: 'transport_error' } };
      }
      return { status: 200, body: { ok: true, prefs: [...rows.values()], areas: [] } };
    }
    if (action === 'prefs_set') {
      if (opts.refuseSet !== undefined) return { status: 422, body: { ok: false, error: opts.refuseSet } };
      const row = rows.get(input.key as string)!;
      const previous = row.value;
      rows.set(row.key, { ...row, value: input.value as PrefView['value'], isDefault: false });
      return { status: 200, body: { ok: true, key: row.key, value: input.value, previousValue: previous, isDefault: false, changed: true } };
    }
    if (action === 'prefs_reset') {
      const keys = input.key !== undefined ? [input.key as string] : [...rows.values()].filter((p) => p.area.id === input.area).map((p) => p.key);
      const reset: string[] = [];
      for (const k of keys) {
        const row = rows.get(k)!;
        if (!row.isDefault) reset.push(k);
        rows.set(k, { ...row, value: row.default, isDefault: true });
      }
      return { status: 200, body: { ok: true, reset, changed: reset.length > 0 } };
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { transport, calls, rows };
}

function renderPage(transport: Transport, workspaceId: string | null = 'ws_test') {
  return render(
    <MemoryRouter>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId={workspaceId}>
            <PrefsProvider>
              <MySettings />
            </PrefsProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>,
  );
}

const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;

beforeEach(() => {
  resetPrefsModuleForTests();
});

describe('Meine Einstellungen (D178 point 7)', () => {
  it('LOADING: the skeleton stands while prefs_list is in flight', async () => {
    const transport = watchReads(neverSettles);
    renderPage(transport);
    await transport.started('prefs_list');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'Meine Einstellungen' })).toBeInTheDocument();
  });

  it('a failed read says so and retries', async () => {
    const e = engine(CATALOG, { failList: 1 });
    renderPage(e.transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('region', { name: 'Darstellung' })).toBeInTheDocument();
    expect(e.calls.filter((c) => c.action === 'prefs_list')).toHaveLength(2);
  });

  it('an empty registry offers the way to the workspace settings', async () => {
    renderPage(engine([]).transport);
    expect(await screen.findByText('Noch keine persönlichen Einstellungen.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Einstellungen des Arbeitsbereichs öffnen' })).toHaveAttribute('href', '/setup');
  });

  it('without a workspace, it says so instead of asking the engine', () => {
    const e = engine();
    renderPage(e.transport, null);
    expect(e.calls).toEqual([]);
  });

  it('groups by area in registry order, with each value, its scope and whether it is the default', async () => {
    renderPage(engine().transport);
    const appearance = await screen.findByRole('region', { name: 'Darstellung' });
    expect(screen.getByRole('region', { name: 'Probe' })).toBeInTheDocument();
    const theme = within(row('appearance.theme'));
    expect(theme.getByRole('radio', { name: 'Wie das System' })).toHaveAttribute('aria-checked', 'true');
    expect(theme.getByText('Standard')).toBeInTheDocument();
    expect(theme.getByText('Gilt in jedem Arbeitsbereich.')).toBeInTheDocument();
    expect(theme.queryByRole('button', { name: 'Farbschema zurücksetzen' })).toBeNull();
    expect(within(row('probe.rows')).getByText('Gilt nur in diesem Arbeitsbereich.')).toBeInTheDocument();
    // A structured preference is named, not shown as JSON, and offers its reset.
    const order = within(row('probe.order'));
    // One line of state ("Angepasst" or "Standard"), never "Standard: Standard" for a json value.
    expect(order.getByText('Angepasst')).toBeInTheDocument();
    expect(order.queryByText(/^Standard:/)).toBeNull();
    expect(order.getByRole('button', { name: 'Reihenfolge zurücksetzen' })).toBeInTheDocument();
    expect(within(appearance).getByRole('button', { name: 'Darstellung: alle zurücksetzen' })).toBeDisabled();
  });

  it('a choice applies at once through prefs_set, then names the default and offers the reset', async () => {
    const e = engine();
    renderPage(e.transport);
    await screen.findByRole('region', { name: 'Darstellung' });
    await userEvent.click(within(row('appearance.theme')).getByRole('radio', { name: 'Dunkel' }));
    expect(within(row('appearance.theme')).getByRole('radio', { name: 'Dunkel' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(e.calls.filter((c) => c.action === 'prefs_set').map((c) => c.input)).toEqual([
        { workspaceId: 'ws_test', key: 'appearance.theme', value: 'dark' },
      ]),
    );
    const theme = within(row('appearance.theme'));
    expect(await theme.findByText('Standard: Wie das System')).toBeInTheDocument();
    await userEvent.click(theme.getByRole('button', { name: 'Farbschema zurücksetzen' }));
    await waitFor(() => expect(theme.getByRole('radio', { name: 'Wie das System' })).toHaveAttribute('aria-checked', 'true'));
    expect(e.calls.at(-1)).toEqual({ action: 'prefs_reset', input: { workspaceId: 'ws_test', key: 'appearance.theme' } });
  });

  it('resets a whole group with prefs_reset { area }', async () => {
    const e = engine();
    renderPage(e.transport);
    const probe = await screen.findByRole('region', { name: 'Probe' });
    await userEvent.click(within(probe).getByRole('button', { name: 'Probe: alle zurücksetzen' }));
    await waitFor(() => expect(within(row('probe.order')).getByText('Standard', { selector: '.my-settings-json' })).toBeInTheDocument());
    expect(e.calls.at(-1)).toEqual({ action: 'prefs_reset', input: { workspaceId: 'ws_test', area: 'probe' } });
  });

  it('a typed value applies on Enter and only when it fits; a yes/no applies at once', async () => {
    const e = engine();
    renderPage(e.transport);
    await screen.findByRole('region', { name: 'Probe' });
    const field = within(row('probe.rows')).getByRole('textbox', { name: 'Zeilen' });
    await userEvent.clear(field);
    await userEvent.type(field, '99{Enter}');
    expect(e.calls.some((c) => c.action === 'prefs_set')).toBe(false);
    expect(within(row('probe.rows')).getByText('Von 1 bis 50')).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, '25{Enter}');
    await waitFor(() => expect(e.calls.filter((c) => c.action === 'prefs_set').map((c) => c.input.value)).toEqual([25]));
    await userEvent.click(within(row('probe.flag')).getByRole('radio', { name: 'Ja' }));
    await waitFor(() => expect(e.calls.filter((c) => c.action === 'prefs_set').map((c) => c.input.value)).toEqual([25, true]));
  });

  it('a refusal is said beside the row and the value goes back', async () => {
    renderPage(engine(CATALOG, { refuseSet: 'invalid_pref_value' }).transport);
    await screen.findByRole('region', { name: 'Darstellung' });
    await userEvent.click(within(row('appearance.density')).getByRole('radio', { name: 'Kompakt' }));
    expect(await within(row('appearance.density')).findByRole('alert')).toHaveTextContent(
      'Dieser Wert passt nicht zu dieser Einstellung. Es wurde nichts geändert.',
    );
    expect(within(row('appearance.density')).getByRole('radio', { name: 'Komfortabel' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the search narrows the rows, and its filtered-empty state clears it', async () => {
    renderPage(engine().transport);
    await screen.findByRole('region', { name: 'Darstellung' });
    const search = screen.getByRole('searchbox', { name: 'Einstellungen durchsuchen' });
    await userEvent.type(search, 'dichte');
    expect(row('appearance.density')).not.toBeNull();
    expect(row('appearance.theme')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Probe' })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, 'xyz');
    expect(screen.getByText('Keine Einstellung passt zu «xyz».')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(search).toHaveValue('');
    expect(row('appearance.theme')).not.toBeNull();
  });

  it('has no axe violations on the success state', async () => {
    const { container } = renderPage(engine().transport);
    await screen.findByRole('region', { name: 'Darstellung' });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the page model', () => {
  it('groups in registry order and matches the search in the current locale', () => {
    expect(groupPrefs(CATALOG).map((g) => [g.id, g.prefs.length])).toEqual([
      ['appearance', 2],
      ['probe', 3],
    ]);
    const density = CATALOG[1]!;
    expect(prefMatches(density, 'DICHTE', 'de-CH')).toBe(true);
    expect(prefMatches(density, 'density', 'en')).toBe(true);
    expect(prefMatches(density, 'appearance.density', 'de-CH')).toBe(true);
    expect(prefMatches(density, 'farbe', 'de-CH')).toBe(false);
  });
});
