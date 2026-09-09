/**
 * The Werkbank matcher (D113): the two-pane workbench, the route, the focus trap and the roving
 * candidate table, plus the two A14-UX-gate fixes that landed with it.
 *
 * What this file owns, and why each assertion bites:
 *
 *  1. THE ROUTE. `/payments/new` is a real route, not a query flag on the list. Mounting at the URL
 *     seeds the money side from the query, so a reload mid-allocation reopens the same matcher, and
 *     `?allocate=<id>` reopens allocation mode against an existing payment's credit. A second fresh
 *     mount stands in for the reload jsdom cannot perform.
 *  2. THE STICKY DECISION COLUMN. The statement, the legs and the running Rest render the engine's
 *     preview figures, side by side with the candidates, so the remainder never leaves the viewport.
 *  3. THE FOCUS TRAP. `aria-modal` is now enforced: Tab cycles inside and cannot walk out to the list
 *     behind the scrim. This was the audit's closeable AA gap.
 *  4. ROVING. The candidate amount fields are one tab stop; ArrowDown moves to the next row's amount.
 *  5. A14-U3. "Noch nichts zugewiesen." renders exactly once on the untouched matcher.
 *  6. A14-U1 and the responsive collapse are asserted against the stylesheet, because vitest stubs
 *     CSS (`css: false`) so jsdom cannot measure a 24px box or evaluate a media query. The source
 *     rule is the regression guard: remove the fix and the assertion fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { focusablesIn } from '../../components/useFocusTrap';
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

const HAPPY: Canned = {
  list_payments: ok(listPayments),
  get_payment: ok(getPayment),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(previewPayment),
  record_payment: ok(recordPayment),
  list_accounts: ok(listAccounts),
  list_contacts: ok({ contacts: [{ id: 'contact_2', name: 'Beispiel GmbH' }] }),
};

/** Mount the whole Payments route tree at `route`, exactly as the router mounts it (`/payments/*`). */
function renderAt(route: string, canned: Canned = HAPPY) {
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

/** Open the matcher and wait until its account read has settled (the picker is populated). */
async function settledMatcher(route = '/payments/new', canned: Canned = HAPPY) {
  renderAt(route, canned);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

// Vitest runs from the app root, and CSS is stubbed (`css: false`), so the stylesheet is read from
// source rather than measured in jsdom.
const CSS = readFileSync(join(process.cwd(), 'src/surfaces/Payments/Payments.css'), 'utf8');

beforeEach(() => {
  installMemoryStorage();
});

describe('the Werkbank route', () => {
  it('mounts the matcher at /payments/new and seeds the money side from the URL', async () => {
    const dialog = await settledMatcher('/payments/new?direction=outgoing&amount=250.00&reference=RF-42');
    expect(within(dialog).getByLabelText('Betrag')).toHaveValue('250.00');
    expect(within(dialog).getByLabelText('Richtung')).toHaveValue('outgoing');
    expect(within(dialog).getByLabelText('Referenz')).toHaveValue('RF-42');
  });

  it('reopens the SAME context on a fresh mount at the same URL (survives a reload)', async () => {
    // jsdom cannot reload, so a second independent mount at the identical URL stands in for it: the
    // matcher context lives in the route, not in transient component state, so it comes back whole.
    const first = await settledMatcher('/payments/new?amount=90.00&reference=INV-7');
    expect(within(first).getByLabelText('Betrag')).toHaveValue('90.00');
    // Tear the first mount down and mount again at the identical URL: the reload jsdom cannot do.
    cleanup();
    const second = await settledMatcher('/payments/new?amount=90.00&reference=INV-7');
    expect(within(second).getByLabelText('Betrag')).toHaveValue('90.00');
    expect(within(second).getByLabelText('Referenz')).toHaveValue('INV-7');
  });

  it('reopens allocation mode at /payments/new?allocate=<id>, warning and amount held', async () => {
    const dialog = await settledMatcher('/payments/new?allocate=pay_9');
    // The one-way warning is the allocation mode's signature (P46).
    expect(within(dialog).getByText(/lässt sich nur rückgängig machen/)).toBeInTheDocument();
    // Amount and direction are the existing payment's, so both are held.
    expect(within(dialog).getByLabelText('Betrag')).toBeDisabled();
    expect(within(dialog).getByLabelText('Richtung')).toBeDisabled();
  });
});

describe('the sticky decision column', () => {
  it('shows the Zuteilung statement, the posting legs and the running Rest, all engine figures', async () => {
    const dialog = await settledMatcher();
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');

    // The statement: preview-payment.fixture.json plans CHF 500.00 against R-2026-0002, remainder 0.
    const statement = await waitFor(() => {
      const node = dialog.querySelector('.pay-statement');
      if (node === null) throw new Error('statement not rendered yet');
      return node as HTMLElement;
    });
    expect(within(statement).getByText('R-2026-0002')).toBeInTheDocument();
    expect(within(statement).getByText('CHF 500.00')).toBeInTheDocument();
    // The Rest line closes the statement, and it is the engine's remainder, not amount minus inputs.
    const rest = dialog.querySelector('.pay-statement-rest') as HTMLElement;
    expect(rest).not.toBeNull();
    expect(within(rest).getByText('CHF 0.00')).toBeInTheDocument();

    // The legs sit in the same sticky column, so the audit trail and the confirm are seen at once.
    const legs = dialog.querySelector('.pay-legs') as HTMLElement;
    expect(within(legs).getByText('1020 Bankkonto')).toBeInTheDocument();
  });

  it('A14-U3: renders "Noch nichts zugewiesen." exactly once on the untouched matcher', async () => {
    const dialog = await settledMatcher();
    // No amount typed: no preview, so the statement states the empty condition. The blocked-reason
    // line beside the confirm must NOT render the same sentence a second time.
    const empties = within(dialog).getAllByText('Noch nichts zugewiesen.');
    expect(empties).toHaveLength(1);
    // And the confirm is still disabled, because the empty condition holds it (D15/C3).
    expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeDisabled();
  });
});

describe('the focus trap (the audit AA gap)', () => {
  it('traps Tab inside the workbench: the last control wraps round to the first', async () => {
    const dialog = await settledMatcher();
    // The same tab-stop set the trap itself uses, so the test and the hook agree on first and last.
    const items = focusablesIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];

    last.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(first).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe('the roving candidate amount fields', () => {
  it('ArrowDown moves focus from one row amount to the next (one tab stop for the list)', async () => {
    const dialog = await settledMatcher();
    const amounts = within(dialog).getAllByLabelText('Zuweisen');
    expect(amounts.length).toBeGreaterThanOrEqual(2);

    await userEvent.click(amounts[0]);
    expect(amounts[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(amounts[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(amounts[0]).toHaveFocus();
  });
});

describe('both empty states name a way out', () => {
  it('nothing open at all points at issuing an invoice', async () => {
    const dialog = await settledMatcher('/payments/new', {
      ...HAPPY,
      suggest_payment_matches: ok({ ...suggestMatches, openItemCount: 0, candidates: [] }),
    });
    expect(await within(dialog).findByText('Es gibt keine offenen Posten.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Rechnung ausstellen' })).toBeInTheDocument();
  });

  it('things open but none fits this money offers to widen the search', async () => {
    const dialog = await settledMatcher('/payments/new', {
      ...HAPPY,
      suggest_payment_matches: ok({ ...suggestMatches, openItemCount: 5, candidates: [] }),
    });
    expect(await within(dialog).findByText('Kein offener Posten passt zu dieser Zahlung.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Suche erweitern' })).toBeInTheDocument();
  });
});

describe('the two A14 UX-gate fixes, guarded against the stylesheet (CSS is stubbed in jsdom)', () => {
  it('A14-U1: the P9 suppress checkbox is raised to the 24px AA floor in a 44px hit row', () => {
    // The bare native checkbox measured 13x13px on the money-path confirm. The fix keeps the native
    // input (for the label, focus ring and keyboard) but sizes its box to the AA floor and makes the
    // wrapping label a full 44px target.
    const box = CSS.match(/\.pay-confirm-suppress input\[type='checkbox'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(box).toMatch(/inline-size:\s*24px/);
    expect(box).toMatch(/block-size:\s*24px/);
    const label = CSS.match(/\.pay-confirm-suppress\s*\{[^}]*\}/)?.[0] ?? '';
    expect(label).toMatch(/min-height:\s*44px/);
  });

  it('the workbench is ONE component that collapses to the stacked order below ~1100px', () => {
    // One component serves both widths: the media query flips the two-column panel to a single column
    // rather than a second component rendering the narrow case.
    expect(CSS).toMatch(/@media\s*\(max-width:\s*1100px\)/);
    const collapse = CSS.match(/@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(collapse).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(collapse).toMatch(/position:\s*static/);
  });

  it('the same DOM carries the money row, the candidate pane and the decision pane at once', async () => {
    // The proof it is one component: at a single width the workbench holds all three, so the
    // responsive stack is a CSS reflow of the same tree, never a swap.
    const dialog = await settledMatcher();
    expect(dialog.querySelector('.pay-money')).not.toBeNull();
    expect(dialog.querySelector('.pay-wb-left')).not.toBeNull();
    expect(dialog.querySelector('.pay-wb-right')).not.toBeNull();
  });
});
