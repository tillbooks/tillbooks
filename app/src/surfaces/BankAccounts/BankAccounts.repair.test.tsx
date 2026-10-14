/**
 * A36 §4.7 (D150): `/bank-accounts?repair=<account>&gap=<gap>` (the attention item, the Übersicht
 * band and the channel panel all link there) opens the gap repair dialog for that gap on the bank
 * accounts surface; a fill that closes the gap closes the dialog and says so on the page. The
 * transport is canned per action; all figures synthetic.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { BankAccounts } from './BankAccounts';
import activeFixture from './list-bank-accounts.fixture.json';
import chartFixture from './list-accounts-with-9100.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const GAP = {
  gapId: 'bst_182:bst_187',
  bankAccountId: 'ba_1',
  source: 'book',
  after: { statementRowId: 'bst_182', documentId: null, number: 182, year: 2026, fromDate: '2026-09-22', toDate: '2026-09-22' },
  before: { statementRowId: 'bst_187', documentId: null, number: 187, year: 2026, fromDate: '2026-09-29', toDate: '2026-09-29' },
  missing: [{ year: 2026, from: 183, to: 186 }],
  oldYearTailUnknown: false,
  missingDates: { from: '2026-09-23', to: '2026-09-28' },
  chains: true,
  differenceMinor: 0,
  currency: 'CHF',
  refused: [],
  confirmable: true,
};

const tile = (gaps: unknown[]) =>
  ok({ tile: { tile: 'bank_inbox', ok: true, accounts: [{ bankAccountId: 'ba_1', name: 'Kontokorrent', currency: 'CHF' }], statementGaps: gaps, channels: [] } });

describe('BankAccounts ?repair=', () => {
  it('the deep link opens the dialog for that gap; a fill that closes it closes the dialog and says so on the page', async () => {
    let reads = 0;
    const canned: Record<string, RestResponse | (() => RestResponse)> = {
      list_bank_accounts: ok(activeFixture),
      list_accounts: ok(chartFixture),
      get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
      bank_channel_status: ok({ channels: [] }),
      dashboard_tile: () => {
        reads += 1;
        return reads === 1 ? tile([GAP]) : tile([]);
      },
      import_camt_files: ok({ statements: [{ file: 'a.xml', part: 1, number: 183, year: 2026, fromDate: '2026-09-23', outcome: 'imported', txnCount: 1 }] }),
    };
    const transport: Transport = async (action) => {
      const entry = canned[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry() : entry;
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/bank-accounts?repair=ba_1&gap=bst_182%3Abst_187']}>
              <BankAccounts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Lücke schliessen' });
    expect(await within(dialog).findByText('Kontokorrent: Auszüge 183–186 fehlen (23.09.2026 bis 28.09.2026)')).toBeInTheDocument();
    await userEvent.upload(within(dialog).getByLabelText('Dateien wählen'), [new File(['<Document/>'], 'a.xml', { type: 'text/xml' })]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Die Lücke ist geschlossen: Auszüge 183–186 sind im Buch.')).toBeInTheDocument();
  });
});
