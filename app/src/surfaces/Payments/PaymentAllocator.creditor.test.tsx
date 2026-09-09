/**
 * The allocator's CREDITOR branch (A17): a vendor bill among the candidates.
 *
 * `suggest_payment_matches` returns vendor bills for an outgoing payment since A17 landed, and the
 * two things this file pins are exactly the two an id-only integration would get wrong:
 *
 *  1. THE LINK. A vendor bill is not a document, so its row must NOT link into `/documents/:id`
 *     (a dead route); it deep-links the Kreditoren list with the bill selected. A bill with no
 *     supplier reference shows what it IS rather than an empty link.
 *  2. THE WIRE. An allocation keyed on the target id alone is looked up in `document`, and a bill
 *     that plainly exists comes back `not_found`. The allocation the drawer sends must carry
 *     `targetKind: 'vendor_bill'`, derived from the candidate the row was built from, while a
 *     document allocation stays exactly as it always was (no targetKind, `documentId` only).
 *
 * The document fixtures are the recorded ones the main suite uses; the vendor-bill candidate is
 * canned by hand because `suggest_payment_matches` is exercised against the live engine in
 * `test/payments/matching.test.mjs` and the creditor settlement path in `test/purchase/`: what THIS
 * file owns is the Studio's handling of the `targetKind` field, which is A17's creditor branch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import Payments from './index';

import listPayments from './list-payments.fixture.json';
import suggestMatches from './suggest-matches.fixture.json';
import previewPayment from './preview-payment.fixture.json';
import recordPayment from './record-payment.fixture.json';
import listAccounts from './list-accounts.fixture.json';
import getPayment from './get-payment.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** One open vendor bill among the candidates, shaped exactly as the engine ranks one. */
const VENDOR_BILL_CANDIDATE = {
  ...suggestMatches.candidates[0],
  targetKind: 'vendor_bill',
  targetId: 'vbill_1',
  number: 'LG-2026-0093',
  contactId: 'vendor_1',
  contactName: 'Lieferant GmbH',
  status: 'posted',
  reference: { kind: 'none', value: null },
  kind: null,
  reason: null,
  prefillMinor: 108100,
  grossMinor: 108100,
  openMinor: 108100,
  deltaMinor: 0,
};

const WITH_BILL = ok({
  ...suggestMatches,
  openItemCount: 3,
  candidates: [VENDOR_BILL_CANDIDATE, ...suggestMatches.candidates],
});

const HAPPY: Canned = {
  list_payments: ok(listPayments),
  get_payment: ok(getPayment),
  suggest_payment_matches: WITH_BILL,
  preview_payment: ok(previewPayment),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: ok({ contacts: [{ id: 'vendor_1', name: 'Lieferant GmbH' }] }),
};

function renderPayments(canned: Canned = HAPPY) {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <MemoryRouter initialEntries={['/payments']}>
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

async function openAllocator(canned: Canned = HAPPY) {
  renderPayments(canned);
  await screen.findByText('Muster AG');
  await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

beforeEach(() => {
  installMemoryStorage();
});

describe('the allocator creditor branch', () => {
  it('links a vendor-bill candidate into the Kreditoren list, never /documents', async () => {
    const dialog = await openAllocator();
    const link = await within(dialog).findByRole('link', { name: 'LG-2026-0093' });
    expect(link).toHaveAttribute('href', '/bills?bill=vbill_1');
    // The sibling DOCUMENT candidate keeps its own route, untouched by the branch.
    expect(within(dialog).getByRole('link', { name: 'R-2026-0002' })).toHaveAttribute(
      'href',
      '/documents/doc_2',
    );
  });

  it('labels a bill with NO supplier reference by what it is, not an empty link', async () => {
    const dialog = await openAllocator({
      ...HAPPY,
      suggest_payment_matches: ok({
        ...suggestMatches,
        candidates: [{ ...VENDOR_BILL_CANDIDATE, number: null }],
      }),
    });
    expect(await within(dialog).findByRole('link', { name: 'Kreditorenrechnung' })).toHaveAttribute(
      'href',
      '/bills?bill=vbill_1',
    );
  });

  it('sends targetKind vendor_bill on the bill allocation and NONE on the document one', async () => {
    const posts: Record<string, unknown>[] = [];
    const dialog = await openAllocator({
      ...HAPPY,
      record_payment: (input: Record<string, unknown>) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });

    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1581');
    // Allocate against BOTH candidates: the bill and the recorded document row.
    const rows = within(dialog).getAllByLabelText('Zuweisen');
    await userEvent.type(rows[0], '1081');
    await userEvent.type(rows[1], '500');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Zahlung buchen' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    const allocations = posts[0].allocations as Record<string, unknown>[];
    const bill = allocations.find((a) => a.documentId === 'vbill_1');
    const doc = allocations.find((a) => a.documentId === 'doc_2');
    expect(bill).toBeDefined();
    expect(doc).toBeDefined();
    // The kind rides with the bill's id, derived from the candidate, never from the direction.
    expect(bill?.targetKind).toBe('vendor_bill');
    expect(bill?.amountMinor).toBe(108100);
    // And a document allocation is EXACTLY what it was before A17: no kind field at all.
    expect('targetKind' in (doc as object)).toBe(false);
    expect(doc?.amountMinor).toBe(50000);
  });
});
