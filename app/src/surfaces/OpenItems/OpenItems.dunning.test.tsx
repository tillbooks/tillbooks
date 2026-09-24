/**
 * A16, Offene Posten: the Mahnstufe chip and the booked-fee sub-line (K-29).
 *
 * The surface shipped rendering NEITHER `dunningLevel` NOR `dunningFeeMinor`, behind a stale comment
 * claiming "the engine hardcodes dunningLevel:0 because A15 is unbuilt". A15 is landed and the engine
 * returns both as real figures (see `src/core/debtors/openItems.ts` and
 * `test/payments/dunning-fee-matching.test.mjs`), so the operator must be able to SEE which part of an
 * open amount is fee, and whether the item has been dunned.
 *
 * WHY A SYNTHETIC ROW HERE, against this suite's "nothing is invented" rule. The shipped fixture world
 * (`test/debtors/studio-open-items-world.mjs`) books no dunning run, so every recorded row carries
 * `dunningLevel: 0, dunningFeeMinor: 0` and cannot exercise the branch. The row below is the recorded
 * `R-2026-0006` with exactly two fields overridden to the values the engine really produces for a
 * booked level-1 fee (level 1, fee 2000 Rappen = CHF 20.00, the same FEE_MINOR the engine suite books).
 * Both are display forms of real engine values, not invented shapes, and the engine suite is what pins
 * that these fields exist and reconcile.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import OpenItems from './index';

import listFixture from './list-open-items.fixture.json';
import agingFixture from './aging-report.fixture.json';
import balanceFixture from './customer-balance.fixture.json';
import configFixture from './aging-bucket-config.fixture.json';

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse>): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

/** The recorded list, with its first document row carrying a real booked level-1 Mahngebühr. */
function listWithBookedFee() {
  const items = listFixture.items.map((item, index) =>
    index === 0 ? { ...item, dunningLevel: 1, dunningFeeMinor: 2000 } : item,
  );
  return { ...listFixture, items };
}

function renderOpenItems(list: Record<string, unknown>) {
  const client = new TillClient(
    fakeTransport({
      list_open_items: ok(list),
      aging_report: ok(agingFixture),
      customer_balance: ok(balanceFixture),
      get_aging_bucket_config: ok(configFixture),
    }),
  );
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/open-items']}>
            <OpenItems />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('A16 Mahnstufe and booked fee (K-29)', () => {
  it('shows the Mahnstufe chip on a dunned row and the booked-fee sub-line in the Offen cell', async () => {
    renderOpenItems(listWithBookedFee());

    // The dunned document is on screen with its level chip beside the link.
    const link = await screen.findByRole('link', { name: 'R-2026-0006' });
    const row = link.closest('tr');
    expect(row).not.toBeNull();
    const cell = within(row as HTMLElement);
    expect(cell.getByText('Mahnstufe 1')).toBeInTheDocument();
    // The booked fee (2000 Rappen) is shown as its own muted sub-line in this row: CHF 20.00.
    expect(cell.getByText('davon Mahngebühr CHF 20.00')).toBeInTheDocument();
  });

  it('renders no Mahnstufe chip and no fee sub-line on an undunned, fee-free row', async () => {
    // The unmodified recording: every row has dunningLevel 0 and dunningFeeMinor 0.
    renderOpenItems(listFixture as unknown as Record<string, unknown>);
    await screen.findByRole('link', { name: 'R-2026-0006' });
    expect(screen.queryByText(/Mahnstufe/)).not.toBeInTheDocument();
    expect(screen.queryByText(/davon Mahngebühr/)).not.toBeInTheDocument();
  });
});
