/**
 * D172, the Einstellungen section. It renders what the engine's `settings_list` says (grouped by the
 * owning capability), offers Ändern only to a person holding the key's owning capability, sends a change
 * only with a value that fits the schema and a non-blank reason, offers the reset only on an overridden
 * setting, re-reads the list after a write, and shows a refusal in words.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { recordedOk } from '../../lib/test-support';
import { WorkspaceSettings, groupSettings, parseDraft, type SettingView } from './WorkspaceSettings';

const SEED: SettingView = {
  key: 'checklists.attention_window_days',
  value: 14,
  default: 14,
  overridden: false,
  schema: { type: 'integer', min: 1, max: 90, unit: 'days' },
  owningCapability: 'manage_checklists',
  dialCapability: 'customize',
  area: { id: 'G22', label: { en: 'Checklists', 'de-CH': 'Checklisten' } },
  label: { en: 'Look-ahead for due checklist steps', 'de-CH': 'Vorschau für fällige Checklisten-Schritte' },
  description: { en: 'How many days ahead.', 'de-CH': 'Wie viele Tage im Voraus.' },
  updatedAt: null,
  updatedBy: null,
};

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse);

function renderSection(routes: Record<string, Route>, caps: Capabilities = ALLOW_ALL) {
  const transport: Transport = async (action, input) => {
    const route = routes[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <CapabilitiesContext.Provider value={caps}>
          <WorkspaceSettings workspaceId="ws_test" />
        </CapabilitiesContext.Provider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const listed = (settings: SettingView[]): RestResponse => ({ status: 200, body: recordedOk({ ok: true, settings }) });

async function openEdit() {
  await screen.findByRole('group', { name: 'Checklisten' });
  const li = document.querySelector('li[data-key="checklists.attention_window_days"]') as HTMLElement;
  await userEvent.click(within(li).getByRole('button', { name: 'Bearbeiten' }));
  return screen.getByRole('dialog');
}

describe('WorkspaceSettings (D172)', () => {
  it('groups by owning capability and shows the value in force and whether it is the default', async () => {
    renderSection({ settings_list: listed([SEED]) });
    const group = await screen.findByRole('group', { name: 'Checklisten' });
    expect(within(group).getByText('14 Tage')).toBeInTheDocument();
    expect(within(group).getByText('Standard')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
  });

  it('an overridden setting names its default', async () => {
    renderSection({ settings_list: listed([{ ...SEED, value: 30, overridden: true }]) });
    expect(await screen.findByText('30 Tage')).toBeInTheDocument();
    expect(screen.getByText('Standard: 14 Tage')).toBeInTheDocument();
  });

  it('offers no Ändern without the owning capability', async () => {
    renderSection({ settings_list: listed([SEED]) }, { ...ALLOW_ALL, can: (c) => c !== 'manage_checklists' });
    await screen.findByText('14 Tage');
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
  });

  it('Speichern needs a changed value inside the bounds and a reason, then writes once and re-reads', async () => {
    const set = vi.fn((_input: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, changed: true } }));
    const list = vi.fn((): RestResponse => listed([SEED]));
    renderSection({ settings_list: list, settings_set: set });
    const dialog = await openEdit();
    const save = within(dialog).getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();
    const value = within(dialog).getByLabelText('Wert');
    await userEvent.clear(value);
    await userEvent.type(value, '120');
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), 'Quartal');
    expect(save).toBeDisabled();
    await userEvent.clear(value);
    await userEvent.type(value, '21');
    expect(save).toBeEnabled();
    await userEvent.clear(within(dialog).getByLabelText('Begründung (Pflicht)'));
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), '   ');
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), 'Monatsabschluss');
    await userEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws_test', key: SEED.key, value: 21, reason: 'Monatsabschluss' });
    expect(typeof set.mock.calls[0]?.[0].idempotencyKey).toBe('string');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the reset is offered only on an overridden setting and sends the reason', async () => {
    const reset = vi.fn((_input: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, changed: true } }));
    const { unmount } = renderSection({ settings_list: listed([SEED]) });
    let dialog = await openEdit();
    expect(within(dialog).queryByRole('button', { name: /Auf Standard zurücksetzen/ })).toBeNull();
    unmount();
    renderSection({ settings_list: listed([{ ...SEED, value: 30, overridden: true }]), settings_reset: reset });
    dialog = await openEdit();
    const button = within(dialog).getByRole('button', { name: 'Auf Standard zurücksetzen (14 Tage)' });
    expect(button).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), 'zurück');
    await userEvent.click(button);
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(reset.mock.calls[0]?.[0]).toMatchObject({ key: SEED.key, reason: 'zurück' });
    expect(reset.mock.calls[0]?.[0]).not.toHaveProperty('value');
  });

  it('a refusal is shown in words and the dialog stays open', async () => {
    renderSection({
      settings_list: listed([SEED]),
      settings_set: { status: 200, body: { ok: false, error: 'invalid_setting_value' } },
    });
    const dialog = await openEdit();
    const value = within(dialog).getByLabelText('Wert');
    await userEvent.clear(value);
    await userEvent.type(value, '20');
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), 'Test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Dieser Wert liegt ausserhalb dessen, was die Einstellung erlaubt.');
  });

  it('parses a draft against the schema and groups in registry order', () => {
    expect(parseDraft(SEED.schema, '21')).toBe(21);
    expect(parseDraft(SEED.schema, '0')).toBeUndefined();
    expect(parseDraft(SEED.schema, '14.5')).toBeUndefined();
    expect(parseDraft({ type: 'boolean' }, 'true')).toBe(true);
    expect(parseDraft({ type: 'enum', values: ['a', 'b'] }, 'c')).toBeUndefined();
    const other = { ...SEED, key: 'x.y', area: { id: 'A00', label: { en: 'Setup', 'de-CH': 'Einrichtung' } } };
    expect(groupSettings([SEED, other, { ...SEED, key: 'checklists.z' }]).map((g) => [g.id, g.settings.length])).toEqual([
      ['G22', 2],
      ['A00', 1],
    ]);
  });
  it('a stale stored value is shown as a warning and the reset is offered (critic D172 r1)', async () => {
    const reset = vi.fn((_input: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, changed: true } }));
    renderSection({ settings_list: listed([{ ...SEED, stale: true, ignoredStoredValue: '120' }]), settings_reset: reset });
    expect(await screen.findByText(/Der gespeicherte Wert 120 passt nicht mehr, der Standard \(14 Tage\) gilt\./)).toBeInTheDocument();
    const dialog = await openEdit();
    await userEvent.type(within(dialog).getByLabelText('Begründung (Pflicht)'), 'aufräumen');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Auf Standard zurücksetzen (14 Tage)' }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
  });
});
