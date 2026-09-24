/**
 * The posting-preview "Buchung anzeigen" toggle (ux finding f17): its label must FLIP and it must
 * expose `aria-expanded`, so a keyboard or screen-reader user is told whether the extra legs are
 * shown. The bug: `onClick` flipped `showLegs` but the label stayed `payment.preview.show` forever,
 * and the control carried no expanded state.
 *
 * The toggle only renders when the preview has more than two legs, so this suite feeds a three-leg
 * preview (the shipped fixture has exactly two) and mounts with an amount prefilled, which fires the
 * preview on mount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** The shipped preview plus a third leg, so `preview.legs.length > 2` and the toggle renders. */
const THREE_LEG_PREVIEW = {
  ...previewPayment,
  legs: [
    ...previewPayment.legs,
    { accountId: 'acc_9', accountNumber: '3200', accountLabel: 'Ertrag', debitMinor: 0, creditMinor: 0 },
  ],
};

const CANNED: Canned = {
  list_payments: ok(listPayments),
  get_payment: ok(getPayment),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(THREE_LEG_PREVIEW),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: ok({ contacts: [{ id: 'contact_2', name: 'Beispiel GmbH' }] }),
};

function renderAt(route: string) {
  const client = new TillClient(fakeTransport(CANNED));
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

describe('the posting-preview toggle (f17)', () => {
  it('flips its label and its aria-expanded when pressed', async () => {
    renderAt('/payments/new?amount=500.00');

    // The toggle appears only after the three-leg preview returns: collapsed, it invites showing and
    // reports itself not expanded. `findByRole` retries until the preview has settled.
    const toggle = await screen.findByRole('button', { name: 'Buchung anzeigen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    // Expanded: the SAME control now invites hiding, and reports itself expanded.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Buchung ausblenden' })).toHaveAttribute('aria-expanded', 'true'),
    );
    // And the stale "anzeigen" label is gone: the label genuinely flipped, not duplicated.
    expect(screen.queryByRole('button', { name: 'Buchung anzeigen' })).not.toBeInTheDocument();
  });
});
