/**
 * D198: the settlement feeds on the Bankkonten screen. What it sends (`set_settlement_source` with the
 * token only when typed, `pull_settlement` with a fresh key), what it shows (a stored token as a glyph,
 * never its value; the last pull), and that a refusal is worded by its code. Canned transport, synthetic
 * data: an invented platform, processor and token.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { SettlementSourcesPanel, sourceRowsOf, type SettlementSourceDto } from './SettlementSourcesPanel';
// The engine's own list_accounts answer for the shipped chart (pinned by test/accounts/studio-list-accounts-fixture.test.mjs).
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refusal = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

const SOURCE: SettlementSourceDto = {
  sourceId: 'stlsrc_1',
  system: 'kurswerk',
  processor: 'zahlfix',
  baseUrl: 'https://kurswerk.example',
  fromDate: '2026-07-01',
  tokenStored: true,
  watermark: '2026-09-30',
  lastPull: { outcome: 'ok', errorCode: null, booked: 13, at: '2026-10-05T08:00:00.000Z', to: '2026-09-30' },
  templateSaved: true,
};

type Call = { action: string; input: Record<string, unknown> };

function renderPanel(answer: (action: string, input: Record<string, unknown>) => RestResponse, canPost = true) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    return answer(action, input as Record<string, unknown>);
  };
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <SettlementSourcesPanel workspaceId="ws_test" canPost={canPost} />
      </I18nProvider>
    </TillClientProvider>,
  );
  return calls;
}

describe('the settlement feeds panel', () => {
  it('lists a source with its stored token as a glyph, never the token, and its last pull', async () => {
    renderPanel(() => ok({ sources: [SOURCE] }));
    expect(await screen.findByText('kurswerk · zahlfix')).toBeInTheDocument();
    expect(screen.getByText('Token im Schlüsselbund gespeichert')).toBeInTheDocument();
    expect(screen.getByText('Vollständig bis 30.09.2026')).toBeInTheDocument();
  });

  it('pulls with a fresh key and says what was booked', async () => {
    const calls = renderPanel((action) =>
      action === 'pull_settlement' ? ok({ import: { booked: 2, alreadyImported: 11, skipped: 4, refused: 0 } }) : ok({ sources: [SOURCE] }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Aktualisieren', description: /Jetzt abholen und buchen/ }));
    expect(await screen.findByText('2 gebucht, 11 schon im Buch, 4 übersprungen, 0 abgelehnt.')).toBeInTheDocument();
    const pull = calls.find((c) => c.action === 'pull_settlement');
    expect(pull?.input).toMatchObject({ workspaceId: 'ws_test', system: 'kurswerk', processor: 'zahlfix' });
    expect(String(pull?.input['idempotencyKey'])).toMatch(/^d198-pull-stlsrc_1-/);
  });

  it('an incomplete feed books nothing and says so (D198 re-cut R3)', async () => {
    renderPanel((action) => (action === 'pull_settlement' ? ok({ complete: false, import: null }) : ok({ sources: [SOURCE] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Aktualisieren', description: /Jetzt abholen und buchen/ }));
    expect(await screen.findByText('Der Feed war unvollständig: nichts gebucht, hol ihn später nochmals ab.')).toBeInTheDocument();
  });

  it('a refused pull is worded by its code', async () => {
    renderPanel((action) => (action === 'pull_settlement' ? refusal('feed_unauthorized') : ok({ sources: [SOURCE] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Aktualisieren', description: /Jetzt abholen und buchen/ }));
    expect(await screen.findByText('Der Feed hat den Token abgelehnt. Speichere den aktuellen Token neu.')).toBeInTheDocument();
  });

  it('editing sends the token only when one was typed, and the field always starts empty', async () => {
    const calls = renderPanel((action) => (action === 'set_settlement_source' ? ok({ sourceId: 'stlsrc_1' }) : ok({ sources: [SOURCE] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Bearbeiten', description: /Quelle bearbeiten/ }));
    const token = screen.getByLabelText('Token (bleibt leer, wenn gespeichert)');
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_source')).toBe(true));
    const saved = calls.find((c) => c.action === 'set_settlement_source');
    expect(saved?.input).toMatchObject({ system: 'kurswerk', processor: 'zahlfix', baseUrl: 'https://kurswerk.example', fromDate: '2026-07-01' });
    expect('feedToken' in (saved?.input ?? {})).toBe(false);
  });

  it('A43 §4: the feed path is optional; empty sends the default, a custom one is kept, the rules sit in the hover hint', async () => {
    const custom = { ...SOURCE, feedPath: '/connectors/kasse/feed' };
    const calls = renderPanel((action) => (action === 'set_settlement_source' ? ok({ sourceId: 'stlsrc_1' }) : ok({ sources: [custom] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Bearbeiten', description: /Quelle bearbeiten/ }));
    const path = screen.getByLabelText('Feed-Pfad');
    expect(path).toHaveValue('/connectors/kasse/feed');
    expect(screen.getByRole('button', { name: 'Info', description: /kein %2e, %2f oder %5c\. Ein geänderter Pfad löscht den gespeicherten Token/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_source')).toBe(true));
    expect(calls.find((c) => c.action === 'set_settlement_source')?.input['feedPath']).toBe('/connectors/kasse/feed');
    // Cleared: the default path is sent, so a custom path saved before is never kept by omission.
    await userEvent.click(await screen.findByRole('button', { name: 'Bearbeiten', description: /Quelle bearbeiten/ }));
    await userEvent.clear(screen.getByLabelText('Feed-Pfad'));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'set_settlement_source')).toHaveLength(2));
    expect(calls.filter((c) => c.action === 'set_settlement_source')[1]?.input['feedPath']).toBe('/api/accounting/till-settlement');
  });

  it('without the post right there is nothing to press', async () => {
    renderPanel(() => ok({ sources: [SOURCE] }), false);
    await screen.findByText('kurswerk · zahlfix');
    expect(screen.queryByRole('button', { name: 'Aktualisieren' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hinzufügen' })).toBeNull();
  });

  it('A43: every source is one row with its type glyph: a feed, a table (with its mapping export) and a file', async () => {
    const profile = { schema: 'till-import-profile/v1', kind: 'settlement_table', id: 'laden.kasse' };
    renderPanel((action) =>
      action === 'get_settlement_template'
        ? ok({ templates: [{ system: 'kurswerk', processor: 'zahlfix' }, { system: 'laden', processor: 'kasse' }, { system: 'markt', processor: 'stand' }] })
        : action === 'get_settlement_table_mapping'
          ? ok({ mappings: [{ system: 'laden', processor: 'kasse', profile }] })
          : ok({ sources: [SOURCE] }),
    );
    expect(await screen.findByText('laden · kasse')).toBeInTheDocument();
    expect(screen.getByTestId('settlement-source-kurswerk-zahlfix')).toHaveAttribute('data-type', 'feed');
    expect(screen.getByTestId('settlement-source-laden-kasse')).toHaveAttribute('data-type', 'table');
    expect(screen.getByTestId('settlement-source-markt-stand')).toHaveAttribute('data-type', 'file');
    expect(screen.getByRole('img', { name: 'Tabelle: ein CSV- oder XLSX-Export' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Herunterladen' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Einstellungen', description: /Buchungsvorlage bearbeiten/ })).toHaveLength(3);
  });

  it('A43: the template icon opens the booking template editor of that source', async () => {
    renderPanel((action) => (action === 'list_accounts' ? ok({ accounts: listAccountsFixture.accounts }) : action === 'vat_codes' ? ok({ taxCodes: [] }) : action === 'get_settlement_template' ? ok({ templates: [] }) : ok({ sources: [SOURCE] })));
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen', description: /Buchungsvorlage bearbeiten/ }));
    expect(await screen.findByRole('form', { name: 'Buchungsvorlage von kurswerk / zahlfix' })).toBeInTheDocument();
  });

  it('A43: importing a profile file saves it as the table mapping of that source', async () => {
    const calls = renderPanel((action) => (action === 'set_settlement_table_mapping' ? ok({ mappingId: 'stltmap_1', changed: true }) : ok({ sources: [SOURCE] })));
    await screen.findByText('kurswerk · zahlfix');
    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    const file = new File([JSON.stringify({ schema: 'till-import-profile/v1', kind: 'settlement_table', id: 'x' })], 'x.json', { type: 'application/json' });
    await userEvent.upload(screen.getByTestId('settlement-profile-input'), file);
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_table_mapping')).toBe(true));
    expect(calls.find((c) => c.action === 'set_settlement_table_mapping')?.input).toMatchObject({ system: 'kurswerk', processor: 'zahlfix', profile: { schema: 'till-import-profile/v1' } });
    expect(await screen.findByText('Tabellenzuordnung gespeichert.')).toBeInTheDocument();
  });

  it('sourceRowsOf merges by system and processor, a feed staying a feed', () => {
    const rows = sourceRowsOf([SOURCE], [{ system: 'kurswerk', processor: 'zahlfix' }], [{ system: 'kurswerk', processor: 'zahlfix', profile: {} }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('feed');
    expect(rows[0]?.profile).toEqual({});
  });
});
