/**
 * Items in a workspace whose books are NOT kept in francs.
 *
 * THE CALL SITE THIS EXISTS FOR. The item row rendered
 * `formatMoney(item.defaultUnitPriceMinor, item.currency ?? 'CHF')`. Because the currency is an
 * explicit argument there, removing `formatMoney`'s defaulted parameter could not reach it: the
 * literal survived the change that closed every other call site in the Studio.
 *
 * The engine cannot send an item without a currency (`item.currency` is TEXT NOT NULL and `mapItem`
 * passes the column through, pinned by `test/format-money/item-currency-fixture.test.mjs`), so the
 * fallback was reachable only over a malformed wire. The honest value for that branch is the
 * WORKSPACE BASE CURRENCY, which is what such an item would be priced in, exactly as the Journal
 * drawer falls back for a line with no currency of its own. A base currency is a setting, not a
 * synonym for CHF.
 *
 * The reachable half was the create form. It preselected 'CHF' and sends `currency` explicitly on
 * every create, so a EUR-based workspace stamped francs into the row of every item made without
 * touching the picker. The engine now resolves an unnamed item currency to `baseCurrencyOf(ctx)`;
 * this is the GUI agreeing with it instead of overriding it with a literal.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Items from './index';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

/** A EUR-base workspace, the shape `get_company_profile` really answers (wrapper, then profile). */
const EUR_PROFILE = ok({ profile: { workspaceId: 'ws_test', name: 'Nomadik GmbH', baseCurrency: 'EUR' } });

// The revenue account comes off the recording of the live `list_accounts` answer, never a literal:
// `Ertrag` was never an account name in the shipped KMU chart. Pinned by
// `test/accounts/studio-list-accounts-fixture.test.mjs`.
const ACCOUNTS = ok({
  accounts: listAccountsFixture.accounts.filter((account) => account.number === '3000'),
});
const VAT = ok({ taxCodes: [] });

function renderItems(canned: Canned) {
  const transport: Transport = async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Items />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const base = (items: unknown[], extra: Canned = {}): Canned => ({
  list_items: ok({ items }),
  list_accounts: ACCOUNTS,
  vat_codes: VAT,
  get_company_profile: EUR_PROFILE,
  ...extra,
});

describe('Items, the base currency is a setting and not a synonym for CHF', () => {
  it('renders the price in the currency the ENGINE gave the item, never a defaulted CHF', async () => {
    renderItems(base([{ id: 'i1', name: 'Export', defaultUnitPriceMinor: 9900, currency: 'USD' }]));
    expect(await screen.findByText('USD 99.00')).toBeInTheDocument();
    expect(screen.queryByText('CHF 99.00')).toBeNull();
  });

  it('falls back to the WORKSPACE base currency for a row with no currency, not to CHF', async () => {
    // Not an engine answer: `item.currency` is TEXT NOT NULL. This is the malformed-wire branch, and
    // it is the whole reason the expression had a fallback at all. EUR is what such an item would be
    // priced in; CHF is a unit these books have never held.
    renderItems(base([{ id: 'i1', name: 'Beratung', defaultUnitPriceMinor: 15000 }]));
    expect(await screen.findByText('EUR 150.00')).toBeInTheDocument();
    expect(screen.queryByText('CHF 150.00')).toBeNull();
  });

  it('preselects the workspace base currency when CREATING an item, not CHF', async () => {
    // The reachable half. The editor sends `currency` explicitly, so whatever this picker shows is
    // what lands in the row: a preselected CHF put francs into a EUR book on every untouched create.
    // One item, so the empty state (which offers a second "New item" trigger) is not on screen.
    renderItems(base([{ id: 'i1', name: 'Beratung', defaultUnitPriceMinor: 15000, currency: 'EUR' }]));
    await userEvent.click(await screen.findByRole('button', { name: 'New item' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Currency')).toHaveValue('EUR');
  });

  it('keeps an EDITED item on its own currency, which is not the workspace default', async () => {
    // Editing must never quietly re-denominate an existing price: the row's own currency wins over
    // the workspace default, and only the two differing makes that visible.
    renderItems(base([{ id: 'i1', name: 'Export', defaultUnitPriceMinor: 9900, currency: 'USD' }]));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Currency')).toHaveValue('USD');
  });

  it('falls back to CHF only when the profile read FAILS, never over an answer the engine gave', async () => {
    // The fallback is a fallback. A surface that cannot name its currency is worse than one naming
    // the common one, and the engine still owns what gets written either way.
    renderItems(
      base([{ id: 'i1', name: 'Beratung', defaultUnitPriceMinor: 15000 }], {
        get_company_profile: { status: 500, body: { ok: false, error: 'internal' } },
      }),
    );
    expect(await screen.findByText('CHF 150.00')).toBeInTheDocument();
  });
});
