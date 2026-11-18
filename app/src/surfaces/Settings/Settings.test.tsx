/**
 * D202, the Einstellungen (G00 §11.7), as the owner's pick A redesigned them (18.11.2026): one page with the
 * search in the header, a rail of the areas, the chosen area's rows or every matching row of every area,
 * rows saved on change without a reason, Rückgängig, the padlock only for a missing right, the agent's areas
 * as one multi-select and the row's Änderungen. SYNTHETIC BY CONSTRUCTION: the catalogue below is invented,
 * except the last suite, which reads the engine's own registry (definitions, never a book).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { resetSettingsCatalogForTests, type SettingEntryView, type SettingsAreaEntry } from '../../lib/settings-index';
import { realSettingsListBody } from '../../lib/settings-test-kit';
import { Settings } from './Settings';
import { shapeOf } from './SettingControl';

const T = (en: string, de: string) => ({ en, 'de-CH': de });
const NO_KW = { en: [], 'de-CH': [] };

function area(id: string, en: string, de: string, extra: Partial<SettingsAreaEntry> = {}): SettingsAreaEntry {
  return { id, label: T(en, de), icon: 'setup', keywords: NO_KW, pages: [], agentMayChange: false, ...extra };
}

const AREAS: SettingsAreaEntry[] = [
  area('bank', 'Bank', 'Bank', {
    keywords: { en: [], 'de-CH': ['Kontoauszug', 'Zahlungsanbieter'] },
    pages: [],
  }),
  area('agent', 'Agent and automation', 'Agent und Automatik', {
    pages: [{ id: 'agent', route: '/agent', label: T('What the agent may do', 'Was der Agent darf'), keywords: NO_KW }],
  }),
  area('firma', 'Company', 'Firma', { pages: [{ id: 'setup', route: '/setup', label: T('Company profile', 'Firmenprofil'), keywords: NO_KW }] }),
];

function setting(p: Partial<SettingEntryView> & Pick<SettingEntryView, 'key' | 'schema' | 'default' | 'section'>, label: [string, string], sub: [string, string], values?: Record<string, [string, string]>): SettingEntryView {
  return {
    value: p.default,
    overridden: false,
    owningCapability: 'manage_settings',
    dialCapability: 'customize',
    label: T(label[1], label[0]),
    description: T('A description.', 'Eine Beschreibung.'),
    humanOnly: false,
    askFirst: false,
    answered: true,
    updatedAt: null,
    updatedBy: null,
    presentation: {
      subgroup: T(sub[1], sub[0]),
      label: T(label[1], label[0]),
      ...(values !== undefined ? { valueLabels: Object.fromEntries(Object.entries(values).map(([k, [de, en]]) => [k, T(en, de)])) } : {}),
      keywords: { en: [], 'de-CH': ['Kurs'] },
    },
    ...p,
  } as SettingEntryView;
}

const FX = setting(
  { key: 'bank.fx_mode', schema: { type: 'enum', values: ['propose_split', 'facts_only'] }, default: 'propose_split', section: 'bank' },
  ['Kartenzahlungen in Fremdwährung', 'Card payments in a foreign currency'],
  ['Bankzeilen', 'Bank lines'],
  { propose_split: ['Aufteilen', 'Split'], facts_only: ['Nur Fakten', 'Facts only'] },
);
const ROW_APPROVE = setting(
  { key: 'bank.row_approve', schema: { type: 'enum', values: ['direct', 'review'] }, default: 'direct', section: 'bank', humanOnly: true, overridden: true, value: 'review' },
  ['Das Häkchen auf einer Bankzeile', 'The tick on a bank line'],
  ['Bankzeilen', 'Bank lines'],
  { direct: ['Direkt', 'At once'], review: ['Prüfung', 'Review'] },
);
const SECTIONS = setting(
  { key: 'agent.settings_sections', schema: { type: 'string', maxLength: 160 }, default: '', section: 'agent', humanOnly: true, owningCapability: 'manage_agent_dial' },
  ['Bereiche, die der Agent ändern darf', 'Areas the agent may change'],
  ['Was der Agent darf', 'What the agent may do'],
);

type Call = { action: string; input: Record<string, unknown> };

function engine(opts: { refuseSet?: string } = {}) {
  const rows = new Map([FX, ROW_APPROVE, SECTIONS].map((s) => [s.key, { ...s }]));
  const calls: Call[] = [];
  const history: Record<string, unknown>[] = [];
  const transport: Transport = async (action, input): Promise<RestResponse> => {
    calls.push({ action, input });
    if (action === 'settings_list') {
      const areas = AREAS.map((a) => ({ ...a, agentMayChange: String(rows.get('agent.settings_sections')!.value).split(',').includes(a.id) }));
      return { status: 200, body: { ok: true, settings: [...rows.values()], unanswered: [], areas } };
    }
    if (action === 'settings_set' && opts.refuseSet !== undefined) {
      return { status: 422, body: { ok: false, error: opts.refuseSet } };
    }
    if (action === 'settings_set') {
      const row = rows.get(input.key as string)!;
      history.unshift({ id: `wsc_${history.length + 1}`, key: row.key, kind: 'set', oldValue: row.overridden ? row.value : null, newValue: input.value, actor: 'studio', seat: 'person', via: 'direct', approvedBy: null, proposedBy: null, at: '2026-11-16T09:00:00Z' });
      const previous = row.value;
      rows.set(row.key, { ...row, value: input.value as string, overridden: true });
      return { status: 200, body: { ok: true, key: row.key, value: input.value, previousValue: previous, overridden: true, changed: true } };
    }
    if (action === 'settings_reset') {
      const row = rows.get(input.key as string)!;
      rows.set(row.key, { ...row, value: row.default, overridden: false });
      return { status: 200, body: { ok: true, key: row.key, value: row.default, previousValue: row.value, overridden: false, changed: true } };
    }
    if (action === 'list_members') {
      return { status: 200, body: { ok: true, members: [{ userId: 'usr_anna', actorId: 'member:usr_anna', displayName: 'Anna Muster', email: 'anna@muster.example' }] } };
    }
    if (action === 'settings_history') {
      const list = input.key === undefined ? history : history.filter((h) => h.key === input.key);
      return { status: 200, body: { ok: true, changes: list.slice(0, Number(input.limit ?? 50)), nextBefore: null } };
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { transport, calls, rows, history };
}

function renderAt(path: string, transport: Transport, can: (capability: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TillClientProvider client={new TillClient(transport)}>
        <CapabilitiesContext.Provider value={{ ...ALLOW_ALL, can }}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_test">
              <Settings />
            </WorkspaceProvider>
          </I18nProvider>
        </CapabilitiesContext.Provider>
      </TillClientProvider>
    </MemoryRouter>,
  );
}

const rowOf = (key: string) => document.querySelector(`.setting-row[data-key="${key}"]`) as HTMLElement;

beforeEach(() => resetSettingsCatalogForTests());

describe('Einstellungen (D202)', () => {
  it('ONE PAGE: the rail lists every area by name, /settings shows the first, and no tiles, counts or "Seite" anywhere', async () => {
    const e = engine();
    renderAt('/settings', e.transport);
    const rail = await screen.findByRole('navigation', { name: 'Bereiche' });
    expect(within(rail).getAllByRole('link').map((a) => a.textContent)).toEqual(['Bank', 'Agent und Automatik', 'Firma']);
    expect(within(rail).getByRole('link', { name: 'Bank' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Einstellungen');
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    expect(document.querySelector('.settings-tiles, .settings-recent, .settings-open-questions')).toBeNull();
    expect(document.body.textContent).not.toMatch(/geändert|Zuletzt|Seite\b/);
  });

  it('a deep link selects its area in the rail and shows that area\'s rows only', async () => {
    const e = engine();
    renderAt('/settings/agent', e.transport);
    const rail = await screen.findByRole('navigation', { name: 'Bereiche' });
    expect(within(rail).getByRole('link', { name: 'Agent und Automatik' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(rowOf('agent.settings_sections')).not.toBeNull());
    expect(rowOf('bank.fx_mode')).toBeNull();
    expect(rowOf('page:agent')).not.toBeNull();
  });

  it('SEARCH: shows every matching setting of every area under its area name; empty says so in one line', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/firma', e.transport);
    const field = await screen.findByRole('searchbox', { name: 'Einstellung suchen' });
    expect(field).toHaveAttribute('placeholder', 'Suchen');
    await user.type(field, 'zahlungsanbieter');
    const results = await screen.findByRole('region', { name: 'Treffer' });
    expect(within(results).getByRole('heading', { name: 'Bank' })).toBeInTheDocument();
    expect(rowOf('bank.fx_mode')).not.toBeNull();
    // A hit is the row itself, changed in place.
    expect(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Nur Fakten' })).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'firmenprofil');
    expect(await screen.findByRole('heading', { name: 'Firma' })).toBeInTheDocument();
    expect(rowOf('page:setup')).not.toBeNull();
    await user.clear(field);
    await user.type(field, 'mondfinsternis');
    expect(await screen.findByText('Keine Einstellung passt zu «mondfinsternis».')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
  });

  it('AREA: plain labels and value words, never a raw value; a change saves at once with no reason, Rückgängig puts it back', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    expect(document.body.textContent).not.toMatch(/propose_split|facts_only/);
    await user.click(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Nur Fakten' }));
    await waitFor(() => expect(e.calls.some((c) => c.action === 'settings_set')).toBe(true));
    const set = e.calls.find((c) => c.action === 'settings_set')!;
    expect(set.input).toMatchObject({ key: 'bank.fx_mode', value: 'facts_only' });
    expect(set.input).not.toHaveProperty('reason');
    await user.click(await screen.findByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(e.calls.filter((c) => c.action === 'settings_reset').length).toBe(1));
    expect(e.rows.get('bank.fx_mode')!.overridden).toBe(false);
  });

  it('PROTECTED: a human-only row says so on its label\'s tip, with no padlock; a changed row shows its dot and Auf Standard zurück', async () => {
    const e = engine();
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.row_approve')).not.toBeNull());
    expect(rowOf('bank.row_approve').querySelector('svg.lock, .settings-lock')).toBeNull();
    expect(rowOf('bank.row_approve')).toHaveAccessibleDescription(/Eine Beschreibung\.\s*Nur eine Person ändert das, nie der Agent\./);
    expect(rowOf('bank.fx_mode')).toHaveAccessibleDescription('Eine Beschreibung.');
    expect(rowOf('bank.row_approve').querySelector('.setting-row-dot')).not.toBeNull();
    expect(rowOf('bank.fx_mode').querySelector('.setting-row-dot')).toBeNull();
    expect(within(rowOf('bank.row_approve')).getByRole('button', { name: 'Auf Standard zurück' })).toBeInTheDocument();
    expect(within(rowOf('bank.fx_mode')).queryByRole('button', { name: 'Auf Standard zurück' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Standard' })).toBeNull();
  });

  it('NO RIGHT: the control stays, disabled, with the padlock and its cause', async () => {
    const e = engine();
    renderAt('/settings/agent', e.transport, (cap) => cap !== 'manage_agent_dial');
    await waitFor(() => expect(rowOf('agent.settings_sections')).not.toBeNull());
    expect(within(rowOf('agent.settings_sections')).getByLabelText('Dafür fehlt dir das Recht in diesem Arbeitsbereich.')).toBeInTheDocument();
    expect(within(rowOf('agent.settings_sections')).getByRole('combobox')).toBeDisabled();
  });

  it('AGENT AREAS: one multi-select ("0 von 3"), no switch in the head; ticking an area saves the list', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/agent', e.transport);
    await waitFor(() => expect(rowOf('agent.settings_sections')).not.toBeNull());
    expect(screen.queryByRole('switch', { name: /Agent darf/ })).toBeNull();
    const pick = within(rowOf('agent.settings_sections')).getByRole('combobox', { name: 'Bereiche, die der Agent ändern darf' });
    expect(pick).toHaveTextContent('0 von 3');
    await user.click(pick);
    await user.click(screen.getByRole('option', { name: 'Bank' }));
    await waitFor(() => expect(e.calls.find((c) => c.action === 'settings_set')?.input).toMatchObject({ key: 'agent.settings_sections', value: 'bank' }));
    await waitFor(() => expect(within(rowOf('agent.settings_sections')).getByRole('combobox')).toHaveTextContent('1 von 3'));
  });

  it('ÄNDERUNGEN: the row history says who changed what and when', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    await user.click(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Nur Fakten' }));
    await waitFor(() => expect(e.calls.some((c) => c.action === 'settings_set')).toBe(true));
    await user.click(within(rowOf('bank.fx_mode')).getByRole('button', { name: /Änderungen/ }));
    const list = await within(rowOf('bank.fx_mode')).findByRole('list', { name: 'Änderungen' });
    expect(list).toHaveTextContent('Aufteilen → Nur Fakten');
    expect(list).toHaveTextContent('Du');
  });

  it('DEEP LINK: ?focus=<key> focuses the row\'s control once; a later save elsewhere does not pull focus back', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/bank?focus=bank.fx_mode', e.transport);
    await waitFor(() => expect(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Aufteilen' })).toHaveFocus());
    const other = within(rowOf('bank.row_approve')).getByRole('radio', { name: 'Direkt' });
    await user.click(other);
    await waitFor(() => expect(e.calls.filter((c) => c.action === 'settings_list').length).toBeGreaterThan(1));
    expect(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Aufteilen' })).not.toHaveFocus();
  });

  it('SEARCHING: no area in the rail is shown as chosen while the search has text', async () => {
    const user = userEvent.setup();
    const e = engine();
    renderAt('/settings/bank', e.transport);
    const rail = await screen.findByRole('navigation', { name: 'Bereiche' });
    expect(within(rail).getByRole('link', { name: 'Bank' })).toHaveAttribute('aria-current', 'page');
    await user.type(screen.getByRole('searchbox', { name: 'Einstellung suchen' }), 'kurs');
    await screen.findByRole('region', { name: 'Treffer' });
    expect(rail.querySelector('[aria-current]')).toBeNull();
  });

  it('OPEN QUESTION: a dot and its words on the label tip, no line under the row; Vorschlag übernehmen answers it', async () => {
    const user = userEvent.setup();
    const e = engine();
    const fx = e.rows.get('bank.fx_mode')!;
    e.rows.set('bank.fx_mode', { ...fx, askFirst: true, answered: false });
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    const row = rowOf('bank.fx_mode');
    expect(row.querySelector('.setting-row-dot--open')).not.toBeNull();
    expect(row).toHaveAccessibleDescription(/^Offene Frage\. Vorschlag: Aufteilen/);
    expect(row.querySelector('.setting-row-status p, .settings-question')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Vorschlag übernehmen' }));
    await waitFor(() => expect(e.calls.find((c) => c.action === 'settings_set')?.input).toMatchObject({ key: 'bank.fx_mode', value: 'propose_split' }));
  });

  it('an unknown area is not found', async () => {
    const e = engine();
    renderAt('/settings/mond', e.transport);
    await waitFor(() => expect(e.calls.some((c) => c.action === 'settings_list')).toBe(true));
    expect(await screen.findByRole('heading', { level: 1 })).not.toHaveTextContent('Einstellungen');
  });

  it('critic L4: the history names a member by name, never the member id, and the agent areas by their names', async () => {
    const user = userEvent.setup();
    const e = engine();
    e.history.unshift({ id: 'wsc_x', key: 'agent.settings_sections', kind: 'set', oldValue: null, newValue: 'bank,agent', actor: 'member:usr_anna', seat: 'person', via: 'direct', approvedBy: null, proposedBy: null, at: '2026-11-16T09:00:00Z' });
    renderAt('/settings/agent', e.transport);
    await waitFor(() => expect(rowOf('agent.settings_sections')).not.toBeNull());
    await user.click(within(rowOf('agent.settings_sections')).getByRole('button', { name: /Änderungen/ }));
    const list = await within(rowOf('agent.settings_sections')).findByRole('list', { name: 'Änderungen' });
    await waitFor(() => expect(list).toHaveTextContent('Anna Muster'));
    expect(list).toHaveTextContent('Bank, Agent und Automatik');
    expect(list.textContent).not.toMatch(/usr_anna|member:/);
  });

  it('critic L5: a refused save puts the value back and says why under the row', async () => {
    const user = userEvent.setup();
    const e = engine({ refuseSet: 'invalid_setting_value' });
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    await user.click(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Nur Fakten' }));
    expect(await within(rowOf('bank.fx_mode')).findByRole('alert')).toHaveTextContent('Dieser Wert liegt ausserhalb dessen, was die Einstellung erlaubt.');
    expect(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Aufteilen' })).toHaveAttribute('aria-checked', 'true');
    expect(within(rowOf('bank.fx_mode')).getByRole('radio', { name: 'Nur Fakten' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
  });

  it('re-check L3: a plugin change says an extension made it and under whose name', async () => {
    const user = userEvent.setup();
    const e = engine();
    e.history.unshift({ id: 'wsc_p', key: 'bank.fx_mode', kind: 'set', oldValue: null, newValue: 'facts_only', actor: 'member:usr_anna', seat: 'plugin', via: 'dial', approvedBy: null, proposedBy: null, at: '2026-11-16T09:00:00Z' });
    renderAt('/settings/bank', e.transport);
    await waitFor(() => expect(rowOf('bank.fx_mode')).not.toBeNull());
    await user.click(within(rowOf('bank.fx_mode')).getByRole('button', { name: /Änderungen/ }));
    const list = await within(rowOf('bank.fx_mode')).findByRole('list', { name: 'Änderungen' });
    await waitFor(() => expect(list).toHaveTextContent('Erweiterung, erlaubt von Anna Muster'));
  });
});

describe('Einstellungen on the REAL catalog (the owner, 18.11.2026)', () => {
  it('the page search finds "Agent genehmigt auf dein Wort" by genehmigt, Wort, chat and its full label', async () => {
    const user = userEvent.setup();
    const transport: Transport = async (action) =>
      action === 'settings_list' ? { status: 200, body: realSettingsListBody() } : { status: 200, body: { ok: true, changes: [], members: [] } };
    renderAt('/settings', transport);
    const field = await screen.findByRole('searchbox', { name: 'Einstellung suchen' });
    for (const q of ['genehmigt', 'Wort', 'chat', 'Agent genehmigt auf dein Wort']) {
      await user.clear(field);
      await user.type(field, q);
      await waitFor(() => expect(rowOf('agent.approve_on_owner_word'), q).not.toBeNull());
    }
    // A human-only row with no padlock, and its tooltip in plain German, never an enum id.
    const row = rowOf('agent.approve_on_owner_word');
    expect(row.querySelector('.settings-lock')).toBeNull();
    expect(row).toHaveAccessibleDescription(/^Aus \(Standard\):.*Nur eine Person ändert das, nie der Agent\.$/);
  });
});

describe('shapeOf: an option text is never cut (coordinator check, 18.11.2026)', () => {
  const T = (en: string, de: string) => ({ en, 'de-CH': de });
  const enumOf = (labels: [string, string][]) => ({
    key: 'x.y',
    schema: { type: 'enum' as const, values: labels.map((_, i) => `v${i}`) },
    presentation: { subgroup: T('', ''), label: T('', ''), keywords: { en: [], 'de-CH': [] }, valueLabels: Object.fromEntries(labels.map(([de, en], i) => [`v${i}`, T(en, de)])) },
  });
  it('two short labels are a Segmented; a label over its share in EITHER locale takes the Select', () => {
    expect(shapeOf(enumOf([['Ein Klick', 'One click'], ['Fragen', 'Ask']]), 'de-CH')).toBe('segmented');
    expect(shapeOf(enumOf([['Ein Klick', 'One click'], ['Regel zuerst zeigen', 'Show the rule first']]), 'de-CH')).toBe('select');
    expect(shapeOf(enumOf([['Kurz', 'Short'], ['Kurz', 'In two steps, later']]), 'de-CH')).toBe('select');
    expect(shapeOf(enumOf([['A', 'A'], ['B', 'B'], ['Nur Bankzeilen', 'Bank lines only']]), 'en')).toBe('select');
    expect(shapeOf(enumOf([['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E']]), 'en')).toBe('select');
  });
  it('no real setting shows a Segmented whose label would be cut', () => {
    const real = realSettingsListBody();
    for (const s of real.settings) {
      if (shapeOf(s) !== 'segmented' || s.schema.type !== 'enum') continue;
      const max = ({ 2: 14, 3: 9, 4: 6 } as Record<number, number>)[s.schema.values.length]!;
      for (const v of s.schema.values) {
        for (const l of ['de-CH', 'en'] as const) expect((s.presentation.valueLabels?.[v]?.[l] ?? v).length, `${s.key} ${v}`).toBeLessThanOrEqual(max);
      }
    }
  });
});
