/**
 * The non-author critic's probes for claude/cl-payment-capture, INVERTED into regression tests.
 *
 * The critic wrote F1, F2 and F3 to assert each defect, so a green run was the reproduction. The fix
 * landed and each one now asserts the CORRECT behaviour on the critic's own repro: a red run here is
 * the defect coming back. P-A11Y was written to pass and is kept as it was.
 *
 *  F1  the pre-assignment is the engine's prefill, never a Studio ranking that overrides a QR reference;
 *  F2  the Konto default only ever comes from a Bankkonto in the base currency;
 *  F3  the confirm posts what it was shown and previewed, never an allocation that landed behind it;
 *  R2-F5  (round 2) a candidate list answered for an OLD question never pre-assigns, and nothing posts
 *      while any read the post depends on has not answered the current question.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { inferBankLedgerAccount, type BankAccountLink, type BankAccountOption } from './model';
import Payments from './index';

import listPayments from './list-payments.fixture.json';
import suggestMatches from './suggest-matches.fixture.json';
import previewPayment from './preview-payment.fixture.json';
import previewRemainder from './preview-remainder.fixture.json';
import recordPayment from './record-payment.fixture.json';
import listAccounts from './list-accounts.fixture.json';
import listBankAccounts from '../BankAccounts/list-bank-accounts.fixture.json';
// The books' base currency, which the Konto default now needs (F2): the pinned Setup recording.
import companyProfile from '../Setup/company-profile.fixture.json';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Canned = Record<string, Handler>;
const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const HAPPY: Canned = {
  list_payments: ok(listPayments),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(previewPayment),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: ok({ contacts: [{ id: 'contact_1', name: 'Muster AG' }, { id: 'contact_2', name: 'Beispiel GmbH' }] }),
  list_bank_accounts: ok(listBankAccounts),
  get_company_profile: ok(companyProfile),
};

function renderAt(route: string, canned: Canned) {
  const client = new TillClient(fakeTransport(canned));
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

describe('F1 (UI): an amount coincidence never wins over the payer reference', () => {
  it('pre-assigns NEITHER when the reference names A (a part payment) and B merely matches the amount', async () => {
    const posts: Record<string, unknown>[] = [];
    const qrrA = '000000000000000000202600011';
    const a = {
      ...suggestMatches.candidates[0],
      targetId: 'doc_a',
      number: 'R-2026-0001',
      openMinor: 51020,
      grossMinor: 51020,
      kind: 'exact_reference',
      reference: { kind: 'qrr', value: qrrA },
      deltaMinor: 1020,
      // The engine's own answer (pinned by test/payments/critic-probe-capture.test.mjs): A is the top
      // tier and carries the prefill; B carries none.
      prefillMinor: 50000,
    };
    const b = { ...suggestMatches.candidates[0], kind: 'exact_amount_customer', prefillMinor: 0 };
    renderAt(`/payments/new?amount=500&counterparty=contact_2&reference=${qrrA}`, {
      ...HAPPY,
      suggest_payment_matches: ok({
        ...suggestMatches,
        reference: { ...suggestMatches.reference, kind: 'qrr', value: qrrA, status: 'matched' },
        referenceMatchCount: 1,
        candidates: [a, b, suggestMatches.candidates[1]],
      }),
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    const table = await waitFor(() => {
      const node = dialog.querySelector('.pay-cand-table');
      if (node === null) throw new Error('no candidate table yet');
      return node as HTMLElement;
    });
    const rowB = within(table).getByText('R-2026-0002').closest('tr') as HTMLElement;
    const rowA = within(table).getByText('R-2026-0001').closest('tr') as HTMLElement;
    // A would stay CHF 10.20 open, so the engine's prefill is a part payment: the person's call.
    expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument();
    expect(within(rowB).getByLabelText('Zuweisen')).toHaveValue('');
    expect(within(rowA).getByLabelText('Zuweisen')).toHaveValue('');

    // The untouched drawer posts no allocation at all: never A's reference with B's money.
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Zahlung buchen' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ reference: qrrA, allocations: [] });
  });

  it('pre-assigns A, the item the reference names, when the engine prefill settles it exactly', async () => {
    const qrrA = '000000000000000000202600011';
    const a = {
      ...suggestMatches.candidates[0],
      targetId: 'doc_a',
      number: 'R-2026-0001',
      kind: 'exact_reference',
      reference: { kind: 'qrr', value: qrrA },
      prefillMinor: 50000,
    };
    const b = { ...suggestMatches.candidates[0], kind: 'exact_amount_customer', prefillMinor: 0 };
    renderAt(`/payments/new?amount=500&counterparty=contact_2&reference=${qrrA}`, {
      ...HAPPY,
      suggest_payment_matches: ok({
        ...suggestMatches,
        reference: { ...suggestMatches.reference, kind: 'qrr', value: qrrA, status: 'matched' },
        referenceMatchCount: 1,
        candidates: [a, b, suggestMatches.candidates[1]],
      }),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await within(dialog).findByText('zugewiesen');
    const table = dialog.querySelector('.pay-cand-table') as HTMLElement;
    expect(within(within(table).getByText('R-2026-0001').closest('tr') as HTMLElement).getByLabelText('Zuweisen')).toHaveValue('500.00');
    expect(within(within(table).getByText('R-2026-0002').closest('tr') as HTMLElement).getByLabelText('Zuweisen')).toHaveValue('');
  });
});

describe('F2: the Konto inference only counts Bankkonten in the payment (base) currency', () => {
  // The recorded chart's bank-and-cash range is 1000 and 1020 only (the A01 guard refuses an invented
  // 1021), so the EUR Bankkonto books on 1000 here: what matters is that it is a DIFFERENT ledger account.
  const offered = listAccounts.accounts.filter((x) => /^10[0-2]/.test(x.number)) as BankAccountOption[];
  const link = (over: Partial<BankAccountLink>): BankAccountLink => ({
    id: 'b',
    name: 'B',
    currency: 'CHF',
    ledgerAccountId: 'acc_2',
    receiveOnly: false,
    archived: false,
    ...over,
  });

  it('CHF QR-IBAN on 1020 plus an EUR account on another ledger account: a CHF outgoing payment asks, never the EUR account', () => {
    const links = [link({ id: 'qr', receiveOnly: true }), link({ id: 'eur', currency: 'EUR', ledgerAccountId: 'acc_1' })];
    expect(inferBankLedgerAccount(offered, links, 'outgoing', 'CHF')).toBeNull();
    // Money coming IN may land on the QR-IBAN, so incoming defaults to its 1020.
    expect(inferBankLedgerAccount(offered, links, 'incoming', 'CHF')).toBe('acc_2');
  });

  it('a single EUR Bankkonto in CHF books: a (CHF) payment asks rather than default to it', () => {
    const links = [link({ id: 'eur', currency: 'EUR', ledgerAccountId: 'acc_1' })];
    expect(inferBankLedgerAccount(offered, links, 'incoming', 'CHF')).toBeNull();
    expect(inferBankLedgerAccount(offered, links, 'outgoing', 'CHF')).toBeNull();
  });
});

describe('F3: the confirm posts only what it was shown and the engine previewed', () => {
  it('no confirm opens while the list is out, and an allocation whose preview never answered is not postable', async () => {
    const posts: Record<string, unknown>[] = [];
    const previews: Record<string, unknown>[] = [];
    let releaseSuggest: (r: RestResponse) => void = () => undefined;
    const unallocated = { ...previewRemainder, amountMinor: 50000, remainderMinor: 50000, onAccountMinor: 50000, baseAmountMinor: 50000 };
    renderAt('/payments/new?amount=500&counterparty=contact_2', {
      ...HAPPY,
      suggest_payment_matches: () =>
        new Promise<RestResponse>((resolve) => {
          releaseSuggest = resolve;
        }),
      preview_payment: (input) => {
        previews.push(input);
        const allocations = input.allocations as unknown[];
        // The plan without allocations answers at once; the one WITH the pre-assignment never does.
        return allocations.length === 0 ? ok(unallocated) : new Promise<RestResponse>(() => undefined);
      },
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    // Round 2 closed the race at its root: while the candidate list is out, the post depends on a read
    // that has not answered, so no confirm can even be opened (the preview alone answering is not enough).
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const early = within(dialog).queryByRole('button', { name: 'Zahlung buchen' });
    if (early !== null) {
      expect(early).toBeDisabled();
      await userEvent.click(early);
    }
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // The list lands and the exact match is pre-assigned, VISIBLY, but its own preview never answers:
    // an allocation no preview confirmed is still not postable.
    await act(async () => {
      releaseSuggest(ok(suggestMatches));
    });
    expect(await within(dialog).findByText('zugewiesen')).toBeInTheDocument();
    await waitFor(() => expect(previews.some((p) => (p.allocations as unknown[]).length > 0)).toBe(true));
    const held = within(dialog).queryByRole('button', { name: 'Zahlung buchen' });
    if (held !== null) {
      expect(held).toBeDisabled();
      await userEvent.click(held);
    }
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });
});

describe('P-A11Y: axe with the pre-assignment shown and the disclosure open (expected clean)', () => {
  it('has no axe violations', async () => {
    const { container } = renderAt('/payments/new?amount=500&counterparty=contact_2', HAPPY);
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await within(dialog).findByText('zugewiesen');
    await userEvent.click(await within(dialog).findByRole('button', { name: /Alle offenen Posten/ }));
    await within(dialog).findByText('R-2026-0003');
    expect(await axe(container)).toHaveNoViolations();
    // Tab from the Zuweisen field leaves the candidate table in one press (the roving tab stop).
    const fields = within(dialog).getAllByLabelText('Zuweisen');
    expect(fields.filter((f) => f.tabIndex === 0)).toHaveLength(1);
  });
});

describe('R2-F5: a candidate list answered for the OLD reference never drives the pre-assignment', () => {
  it('drops A the moment the reference changes, holds the post until the list answers, and never posts A under B', async () => {
    const posts: Record<string, unknown>[] = [];
    const qrrB = '000000000000000000202600051';
    const held: Array<(r: RestResponse) => void> = [];
    // A: the exact-amount-and-customer item the engine prefills BEFORE any reference is typed.
    const a = { ...suggestMatches.candidates[0], kind: 'exact_amount_customer', prefillMinor: 50000 };
    // B: CHF 510.20 of the same customer; the payer quotes B's QRR and deducted 2% Skonto.
    const b = {
      ...suggestMatches.candidates[0],
      targetId: 'doc_b',
      number: 'R-2026-0005',
      openMinor: 51020,
      grossMinor: 51020,
      kind: null,
      prefillMinor: 0,
      reference: { kind: 'qrr', value: qrrB },
      deltaMinor: 1020,
    };
    renderAt('/payments/new?amount=500&counterparty=contact_2', {
      ...HAPPY,
      suggest_payment_matches: (input) =>
        input.reference === undefined
          ? ok({ ...suggestMatches, candidates: [a, b] })
          : // The engine's answer WITH the reference is slower than the preview's (it scans every item).
            new Promise<RestResponse>((resolve) => held.push(resolve)),
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await within(dialog).findByText('zugewiesen');

    // The person pastes B's QR reference.
    await userEvent.click(within(dialog).getByLabelText('Referenz'));
    await userEvent.paste(qrrB);
    // The list on screen answers the OLD reference: A is no longer pre-assigned from it...
    await waitFor(() => expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument());
    // ...and while B's list is out, nothing can post (the preview alone answering is not enough).
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    const heldButton = within(dialog).queryByRole('button', { name: 'Zahlung buchen' });
    if (heldButton !== null) {
      expect(heldButton).toBeDisabled();
      await userEvent.click(heldButton);
    }
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);

    // The engine's answer for B's reference lands: B is the reference match now.
    await act(async () => {
      for (const resolve of held)
        resolve(
          ok({
            ...suggestMatches,
            referenceMatchCount: 1,
            candidates: [
              { ...b, kind: 'exact_reference', prefillMinor: 50000 },
              { ...a, prefillMinor: 0 },
            ],
          }),
        );
    });
    // B's prefill is a part payment (CHF 10.20 would stay open), so nothing is pre-assigned now.
    const button = await within(dialog).findByRole('button', { name: 'Zahlung buchen' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument();
    await userEvent.click(button);
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // Never the F1 outcome (B's reference, A's money): nothing allocated, as the screen showed.
    expect(posts[0]).toMatchObject({ reference: qrrB, allocations: [] });
  });

  it('same race with the confirm suppressed: a click before the list answers posts nothing', async () => {
    const posts: Record<string, unknown>[] = [];
    const qrrB = '000000000000000000202600051';
    const a = { ...suggestMatches.candidates[0], kind: 'exact_amount_customer', prefillMinor: 50000 };
    const { setConfirmPostSuppressed } = await import('./confirm-preference');
    setConfirmPostSuppressed('ws_test', true);
    renderAt('/payments/new?amount=500&counterparty=contact_2', {
      ...HAPPY,
      suggest_payment_matches: (input) =>
        input.reference === undefined ? ok({ ...suggestMatches, candidates: [a] }) : new Promise<RestResponse>(() => undefined),
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Zahlung erfassen' });
    await within(dialog).findByText('zugewiesen');
    await userEvent.click(within(dialog).getByLabelText('Referenz'));
    await userEvent.paste(qrrB);
    await waitFor(() => expect(within(dialog).queryByText('zugewiesen')).not.toBeInTheDocument());
    // The list for B's reference never answers: the post stays held however long it is clicked.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const button = within(dialog).queryByRole('button', { name: 'Zahlung buchen' });
    if (button !== null) {
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(posts).toHaveLength(0);
  });
});
