/**
 * D192 point 2 (code critic r1 R2): a Skonto or a write-off on an invoice a fixed-asset disposal cleared.
 * The engine's preview names the disposal (`invoice_cleared_by_disposal`); the allocator shows it BEFORE
 * the click, in words, beside the confirm. A warning only: nothing is held.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import Payments from './index';

import listPayments from './list-payments.fixture.json';
import getPayment from './get-payment.fixture.json';
import suggestMatches from './suggest-matches.fixture.json';
import previewPayment from './preview-payment.fixture.json';
import recordPayment from './record-payment.fixture.json';
import listAccounts from './list-accounts.fixture.json';
// Pinned to the live engine by `test/banking/studio-bank-accounts-fixture.test.mjs`; both of its
// Bankkonten book on acc_2, which is what the Werkbank's Konto defaults to (D152).
import listBankAccounts from '../BankAccounts/list-bank-accounts.fixture.json';
// The books' base currency, which the Konto default needs (critic F2): the Setup recording, pinned to the
// live engine by `test/setup/profile-fixture.test.mjs`.
import companyProfile from '../Setup/company-profile.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const CLEARED_PREVIEW = {
  ...previewPayment,
  warnings: [{ code: 'invoice_cleared_by_disposal', assetNumber: 'FA-0001', disposalDate: '2026-07-19', transactionId: 'atxn_1' }],
};

const canned = (preview: unknown): Canned => ({
  list_payments: ok(listPayments),
  get_payment: ok(getPayment),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(preview as Record<string, unknown>),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: ok({ contacts: [{ id: 'contact_2', name: 'Beispiel GmbH' }] }),
  list_bank_accounts: ok(listBankAccounts),
  get_company_profile: ok(companyProfile),
});

function renderAt(route: string, c: Canned) {
  const client = new TillClient(fakeTransport(c));
  return render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={client}>
            <Routes>
              <Route path="/payments/*" element={<Payments />} />
            </Routes>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installMemoryStorage();
});

describe('the allocator names a disposal that cleared the invoice (D192 point 2)', () => {
  it('shows the engine\'s invoice_cleared_by_disposal before the click, as a status line in words', async () => {
    renderAt('/payments/new?amount=500.00', canned(CLEARED_PREVIEW));
    const line = await screen.findByText(/Abgang der Anlage FA-0001 vom 19\.07\.2026/);
    expect(line).toHaveAttribute('role', 'status');
    expect(screen.queryByText('invoice_cleared_by_disposal')).toBeNull();
  });
});
