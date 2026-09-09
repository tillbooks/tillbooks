/**
 * The human allocator can reach a booked Mahngebühr (K-29).
 *
 * The engine has accepted `target_kind = 'dunning_fee'` since the A14 follow-up, but the allocator is
 * driven solely by `suggest_payment_matches.candidates`, so until the matcher emitted a `dunning_fee`
 * candidate there was no row for a human to type an amount against. This suite proves the surface half:
 * a fee candidate renders (as a label, never a dead `/documents/:id` link), and typing an amount
 * against it builds an allocation carrying `targetKind: 'dunning_fee'` on the wire, which is exactly
 * what makes the engine settle the FEE receivable and not the invoice principal.
 *
 * The preview fires on every keystroke and carries the built `allocations`, so capturing the
 * `preview_payment` request body is the cleanest place to assert the wire shape, with no confirm
 * dialog in the path.
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
import previewPayment from './preview-payment.fixture.json';
import listAccounts from './list-accounts.fixture.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** A matches read whose only candidate is a booked level-1 Mahngebühr (targetId = the dunning_item). */
const FEE_MATCHES = {
  reference: { kind: 'none', value: null },
  openItemCount: 1,
  referenceMatchCount: 0,
  writeOffThresholdMinor: 100,
  candidates: [
    {
      targetKind: 'dunning_fee',
      targetId: 'dunning_item_1',
      number: 'R-2026-0001 Mahngebühr Stufe 1',
      contactId: 'contact_2',
      contactName: 'Beispiel GmbH',
      currency: 'CHF',
      dueDate: '2026-06-01',
      daysOverdue: 48,
      grossMinor: 2000,
      paidMinor: 0,
      openMinor: 2000,
      status: 'booked',
      reference: null,
      kind: 'exact_amount_customer',
      reason: 'exact_amount_customer',
      deltaMinor: 0,
      prefillMinor: 0,
      settled: false,
      disabledReason: null,
    },
  ],
};

beforeEach(() => {
  installMemoryStorage();
});

function mount(onPreview?: Handler) {
  const canned: Canned = {
    list_payments: ok(listPayments),
    get_payment: ok(getPayment),
    suggest_payment_matches: ok(FEE_MATCHES),
    preview_payment: onPreview ?? ok(previewPayment),
    list_accounts: ok(listAccounts),
    list_contacts: ok({ contacts: [{ id: 'contact_2', name: 'Beispiel GmbH' }] }),
  };
  const client = new TillClient(fakeTransport(canned));
  return render(
    <MemoryRouter initialEntries={['/payments/new?amount=20.00']}>
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

describe('the dunning_fee candidate in the allocator (K-29)', () => {
  it('renders the fee label as text, never a dead document link', async () => {
    mount();

    // The fee candidate appears after the matches read returns; `findByText` retries until then.
    expect(await screen.findByText('R-2026-0001 Mahngebühr Stufe 1')).toBeInTheDocument();
    // A fee is not a routable document: it must NOT be a link.
    expect(screen.queryByRole('link', { name: 'R-2026-0001 Mahngebühr Stufe 1' })).not.toBeInTheDocument();
  });

  it('builds an allocation carrying targetKind dunning_fee when an amount is typed against it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    mount((input) => {
      seen.push(input);
      return ok(previewPayment);
    });

    // Type the fee amount against the candidate's own "Zuweisen" input (present once the read settles).
    const amountInput = await screen.findByLabelText('Zuweisen');
    await userEvent.type(amountInput, '20.00');

    // The preview fires with the built allocation; it must name the fee item AND its kind.
    // The preview fires per keystroke, so match on the FINAL typed amount (2000 Rappen), not an
    // intermediate one, and assert the kind rides the id all the way to the wire.
    await waitFor(() => {
      const withFee = seen.find((body) =>
        (body.allocations as Array<Record<string, unknown>> | undefined)?.some(
          (a) => a.documentId === 'dunning_item_1' && a.targetKind === 'dunning_fee' && a.amountMinor === 2000,
        ),
      );
      expect(withFee).toBeDefined();
      const alloc = (withFee!.allocations as Array<Record<string, unknown>>).find(
        (a) => a.documentId === 'dunning_item_1',
      );
      expect(alloc).toMatchObject({ documentId: 'dunning_item_1', targetKind: 'dunning_fee', amountMinor: 2000 });
    });
  });
});
