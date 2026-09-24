/**
 * The A14 Studio suite: five states per surface, driven by fixtures captured from the LIVE engine.
 *
 * Every payload rendered here comes from `*.fixture.json`, and
 * `test/payments/studio-payments-fixture.test.mjs` pins each of those to the real engine, keys and
 * kinds. That pairing is what stops this file from being the comfortable kind of green: a suite
 * rendering shapes its author invented agrees with the author, not with the product.
 *
 * The LOADING tests all prove the read went in flight with `transport.started(...)`, per
 * `app/src/loading-state-convention.test.ts`. Every surface here initialises `loading` to `true`, so
 * a skeleton is on screen at the first commit, before any effect fires: asserting `role="status"`
 * without awaiting the seam would pass over a surface that reads nothing at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { setConfirmPostSuppressed } from './confirm-preference';
import { neverSettles, watchReads } from '../../test-transport';
import Payments from './index';

import listPayments from './list-payments.fixture.json';
import getPayment from './get-payment.fixture.json';
import suggestMatches from './suggest-matches.fixture.json';
import previewPayment from './preview-payment.fixture.json';
import previewBlocked from './preview-blocked.fixture.json';
import needsFxRate from './needs-fx-rate.fixture.json';
import recordPayment from './record-payment.fixture.json';
import listAccounts from './list-accounts.fixture.json';
import previewRemainder from './preview-remainder.fixture.json';
import type { BankAccountOption } from './model';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/**
 * A rejection, which is not merely "not ok": `Err` requires the stable machine-readable `error`
 * code, because that code is what the surface maps to a message. Asking for it in the parameter is
 * what retires the only load-bearing cast in this file. The body used to be built from a bare
 * `Record<string, unknown>` and cast with `as never`, so `reject({})` type-checked and would have
 * handed the surface a rejection with no code to map.
 */
const reject = (body: { error: string } & Record<string, unknown>, status = 422): RestResponse => ({
  status,
  body: { ...body, ok: false },
});

/**
 * The accounts read the allocator's S9 picker filters down to bank and cash.
 *
 * This used to be hand-written, and it hand-set BOTH `label` and `name` on every row. `list_accounts`
 * answers `name` and has no `label` at all, so the picker rendered "1000 undefined" in the browser
 * while this suite stayed green: the fixture was more generous than the engine, and a fixture that is
 * more generous than the engine agrees with the bug. It is now the captured payload, pinned to the
 * live `listAccounts` by `test/payments/studio-payments-fixture.test.mjs`.
 */
const ACCOUNTS = ok(listAccounts);

/**
 * The compile-time half of the pin: the captured payload has to satisfy the type the picker reads.
 * If the engine renames `name` and the fixture is recaptured, this stops compiling instead of
 * rendering `undefined` on screen.
 *
 * It claimed that from 2026-07-22 and did none of it until 2026-07-26, for two reasons at once.
 * `app/tsconfig.json` excluded every `*.test.tsx`, so nothing compiled this line; and every fixture
 * reached `ok()` through `as never`, which erases the argument type and checks nothing on the way
 * in. There were 23 of those casts. Removing all 23 left exactly ONE error, in `reject` below, so
 * 22 of them were hiding nothing whatsoever.
 */
const _accountsMatchTheReadModel: BankAccountOption[] = listAccounts.accounts;
void _accountsMatchTheReadModel;

const CONTACTS = ok({
  contacts: [
    { id: 'contact_1', name: 'Muster AG' },
    { id: 'contact_2', name: 'Beispiel GmbH' },
  ],
});

const HAPPY: Canned = {
  list_payments: ok(listPayments),
  get_payment: ok(getPayment),
  suggest_payment_matches: ok(suggestMatches),
  preview_payment: ok(previewPayment),
  record_payment: ok(recordPayment),
  list_accounts: ACCOUNTS,
  list_contacts: CONTACTS,
};

/**
 * K-26: the whole row opens the payment in the drawer (no per-row expander any more). Click the first
 * payment row, named by its date and amount, and wait for the drawer.
 */
async function openFirstPayment(): Promise<HTMLElement> {
  await userEvent.click(screen.getAllByRole('row', { name: /^Zahlung vom / })[0]!);
  return screen.findByRole('dialog', { name: /^Zahlung vom / });
}

function renderPayments(canned: Canned = HAPPY, transport?: Transport, route = '/payments') {
  const client = new TillClient(transport ?? fakeTransport(canned));
  return render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={client}>
            {/* Mounted at the SPLAT, exactly as the app router mounts it. The surface owns a nested
                route tree (`/payments/new` is the P21 handover), and those sub-routes only resolve
                relative to a splat parent. Rendering the surface bare would test a mounting the
                product does not use. */}
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

// --- S1, the Zahlungen list ----------------------------------------------------------------------

describe('S1: the Zahlungen list, in all five states', () => {
  it('LOADING: shows a skeleton while list_payments is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    renderPayments(HAPPY, transport);
    // The proof. Without it this assertion holds over a surface that reads nothing at all.
    await transport.started('list_payments');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('EMPTY: invites the first payment, and does not blame a filter that is not set', async () => {
    renderPayments({ ...HAPPY, list_payments: ok({ payments: [] }) });
    expect(await screen.findByText('Noch keine Zahlungen.')).toBeInTheDocument();
    expect(screen.queryByText(/Keine Zahlungen in dieser Richtung/)).not.toBeInTheDocument();
  });

  it('EMPTY (filtered): says the FILTER is empty and offers to reset it', async () => {
    renderPayments({ ...HAPPY, list_payments: ok({ payments: [] }) }, undefined, '/payments?direction=outgoing');
    expect(await screen.findByText('Keine Zahlungen in dieser Richtung.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter zurücksetzen' })).toBeInTheDocument();
  });

  it('ERROR: names what failed and offers a retry that re-reads', async () => {
    let calls = 0;
    renderPayments({
      ...HAPPY,
      list_payments: () => {
        calls += 1;
        return calls === 1 ? reject({ error: 'transport_error' }) : ok(listPayments);
      },
    });
    expect(await screen.findByText('Zahlungen konnten nicht geladen werden.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByText('Muster AG')).toBeInTheDocument();
  });

  it('DENIED: says the right is missing rather than showing an empty table', async () => {
    renderPayments({ ...HAPPY, list_payments: reject({ error: 'permission_denied' }, 403) });
    expect(await screen.findByText(/Dir fehlt die Berechtigung, Zahlungen zu buchen/)).toBeInTheDocument();
  });

  it('POPULATED: renders the row with money as CHF 1’234.56 and the date as 19.07.2026', async () => {
    renderPayments();
    expect(await screen.findByText('Muster AG')).toBeInTheDocument();
    expect(screen.getByText('19.07.2026')).toBeInTheDocument();
    expect(screen.getByText("CHF 1'100.00")).toBeInTheDocument();
  });

  it('keeps the status word-only, with Guthaben as a CHIP that never replaces it', async () => {
    renderPayments();
    // The payment settled an invoice AND carries a credit. Both facts stay visible: a status word
    // that read "Guthaben" would hide the settlement the same payment performed.
    expect(await screen.findByText('Gebucht')).toBeInTheDocument();
    expect(screen.getByText('Guthaben CHF 19.00')).toBeInTheDocument();
  });

  it('gives the Guthaben a live Zuweisen action, so a credit is never a dead label', async () => {
    renderPayments();
    const allocate = await screen.findByRole('button', { name: 'Zuweisen' });
    await userEvent.click(allocate);
    // The allocator opens in allocation mode and states the one-way warning (P46).
    expect(await screen.findByText(/lässt sich nur rückgängig machen/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderPayments();
    await screen.findByText('Muster AG');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('K-26: one line per payment on the shared table, the detail in a drawer, the rest in one overflow', async () => {
    renderPayments();
    await screen.findByText('Muster AG');
    // The Guthaben is a note in the row, not a second row under it.
    const row = screen.getAllByRole('row', { name: /^Zahlung vom / })[0]!;
    expect(within(row).getByText('Guthaben CHF 19.00')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Zuweisen' })).toBeInTheDocument();
    // The status is the shared Status word.
    expect(within(row).getByText('Gebucht').closest('.status-word')).toHaveAttribute('data-kind', 'success');
    // No expander glyph and no raw ISO date in the row (K-38).
    expect(row.textContent ?? '').not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The row opens its detail in the drawer.
    const drawer = await openFirstPayment();
    expect(await within(drawer).findByRole('link', { name: 'R-2026-0001' })).toBeInTheDocument();
  });

  it('K-11: the direction is a Segmented control', async () => {
    renderPayments();
    await screen.findByText('Muster AG');
    const group = screen.getByRole('radiogroup', { name: 'Richtung' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

// --- S3, the expanded detail ---------------------------------------------------------------------

describe('S3: the payment detail', () => {
  it('LOADING: proves get_payment went in flight before claiming a skeleton', async () => {
    // `get_payment` hangs while every other action answers, so the list renders and the row can be
    // expanded at all. Hanging the whole transport would leave nothing to click.
    const hanging = watchReads(async (action, input) =>
      action === 'get_payment' ? neverSettles(action, input) : fakeTransport(HAPPY)(action, input),
    );
    renderPayments(HAPPY, hanging);
    // Wait for the LIST (the header, glyph included, renders before any data), then expand the
    // first ROW: the G17 surface-help glyph is also a collapsed disclosure and must be excluded.
    await screen.findByText('Muster AG');
    await openFirstPayment();
    await hanging.started('get_payment');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('links the allocation by document NUMBER and the payment to its journal entry', async () => {
    renderPayments();
    await screen.findByText('Muster AG');
    await openFirstPayment();
    expect(await screen.findByRole('link', { name: 'R-2026-0001' })).toBeInTheDocument();
    // Deep-links the ENTRY, not a generic /journal (the A10-G17 defect class).
    expect(screen.getByRole('link', { name: 'Buchung ansehen' })).toHaveAttribute(
      'href',
      expect.stringContaining('entry='),
    );
  });

  it('routes each allocation by its targetKind: a vendor bill to /bills, a dunning fee to plain text', async () => {
    // A payment can settle a supplier bill or a dunning fee, neither of which is a /documents/:id
    // route. A blind /documents link 404s the bill; the fee has no routable target at all.
    const mixedTargets = {
      ...HAPPY,
      get_payment: ok({
        ...getPayment,
        payment: {
          ...getPayment.payment,
          allocations: [
            {
              ...getPayment.payment.allocations[0],
              id: 'palloc_bill',
              targetKind: 'vendor_bill',
              targetId: 'bill_9',
              targetNumber: 'LF-2026-0007',
            },
            {
              ...getPayment.payment.allocations[0],
              id: 'palloc_fee',
              targetKind: 'dunning_fee',
              targetId: 'ditem_3',
              targetNumber: 'R-2026-0001 Mahngebühr Stufe 1',
            },
          ],
        },
      }),
    };
    renderPayments(mixedTargets);
    await screen.findByText('Muster AG');
    await openFirstPayment();
    // The vendor bill links to /bills, never /documents.
    const billLink = await screen.findByRole('link', { name: 'LF-2026-0007' });
    expect(billLink).toHaveAttribute('href', expect.stringContaining('/bills?bill=bill_9'));
    // The dunning fee is plain text, not a link.
    expect(screen.getByText('R-2026-0001 Mahngebühr Stufe 1')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'R-2026-0001 Mahngebühr Stufe 1' }),
    ).not.toBeInTheDocument();
  });

  it('humanises the manual source and never leaks the raw enum', async () => {
    renderPayments();
    await screen.findByText('Muster AG');
    await openFirstPayment();
    await screen.findByRole('link', { name: 'R-2026-0001' });
    expect(screen.getByText(/Quelle: Manuell/)).toBeInTheDocument();
    expect(screen.queryByText(/Quelle: manual/)).not.toBeInTheDocument();
  });

  it('C3: names the actor that recorded the payment, verbatim from the read model', async () => {
    renderPayments();
    await screen.findByText('Muster AG');
    await openFirstPayment();
    // `createdBy: 'user_1'` on a `manual` source reads as a human hand, named verbatim.
    expect(await screen.findByText(/Erfasst durch user_1/)).toBeInTheDocument();
  });

  it('C3: shows the neutral form and no fabricated name when the payment has no actor', async () => {
    const noActor = {
      ...HAPPY,
      get_payment: ok({
        ...getPayment,
        payment: { ...getPayment.payment, createdBy: null },
      }),
    };
    renderPayments(noActor);
    await screen.findByText('Muster AG');
    await openFirstPayment();
    await screen.findByRole('link', { name: 'R-2026-0001' });
    expect(screen.getByText(/^Erfasst,/)).toBeInTheDocument();
    expect(screen.queryByText(/Erfasst durch/)).not.toBeInTheDocument();
  });
});

// --- S2, the allocator ---------------------------------------------------------------------------

async function openAllocator(canned: Canned = HAPPY) {
  renderPayments(canned);
  await screen.findByText('Muster AG');
  await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
  return screen.findByRole('dialog');
}

/**
 * The allocator with its OWN THREE reads answered, rather than the first frame of it.
 *
 * Opening the drawer mounts `PaymentAllocator`, which immediately issues `list_accounts`,
 * `list_contacts` and `suggest_payment_matches`. The drawer paints its chrome on the first commit,
 * so `findByRole('dialog')` resolves while all three are still out.
 *
 * Proof that the dialog alone claimed nothing: with all three hung forever, "has no axe violations
 * with the drawer open" still passed. It was auditing an empty bank-account select and a spinner
 * where a person reads the candidate list, and it held that pending state across the hundreds of
 * milliseconds an axe pass takes, which is the window an un-acted update lands in.
 *
 * The wait is on `aria-busy`, NOT on `role="status"`, and that is the whole precision of it. The
 * account picker announces its load as `<select disabled aria-busy="true">` and the candidate list
 * as a `Skeleton`, which is `role="status" aria-busy="true"`: `aria-busy` covers both, and all three
 * reads are behind those two flags. `role="status"` alone does not work, because the blocked-payment
 * reason beside the confirm is a permanent `role="status"` in the settled drawer, so waiting for it
 * to go never finishes. The first draft of this helper did exactly that and hung for the full 4s.
 *
 * It takes the dialog rather than opening one, because the caller that needs it also needs the
 * `container` that `openAllocator` does not hand back.
 */
async function settleAllocator(dialog: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

describe('S2/S4/S5: the allocator, stacked money then candidates then preview', () => {
  it('LOADING: proves suggest_payment_matches went in flight', async () => {
    const transport = watchReads(async (action, input) =>
      action === 'suggest_payment_matches' ? neverSettles(action, input) : fakeTransport(HAPPY)(action, input),
    );
    renderPayments(HAPPY, transport);
    await screen.findByText('Muster AG');
    await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
    await transport.started('suggest_payment_matches');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('EMPTY (a): no open items at all points at issuing an invoice', async () => {
    await openAllocator({
      ...HAPPY,
      suggest_payment_matches: ok({ ...(suggestMatches), candidates: [], openItemCount: 0 }),
    });
    expect(await screen.findByText('Es gibt keine offenen Posten.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rechnung ausstellen' })).toBeInTheDocument();
  });

  it('EMPTY (b): open items exist but none fits, which is a DIFFERENT state with a different way out', async () => {
    await openAllocator({
      ...HAPPY,
      suggest_payment_matches: ok({ ...(suggestMatches), candidates: [], openItemCount: 4 }),
    });
    expect(await screen.findByText('Kein offener Posten passt zu dieser Zahlung.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suche erweitern' })).toBeInTheDocument();
    expect(screen.queryByText('Es gibt keine offenen Posten.')).not.toBeInTheDocument();
  });

  it('counts open items and reference matches as TWO numbers, so a ranked list never reads as filtered', async () => {
    await openAllocator();
    expect(await screen.findByText('0 von 2 offenen Posten')).toBeInTheDocument();
  });

  it('states the tier in words for a ranked row', async () => {
    await openAllocator();
    expect(await screen.findByText('Betrag und Kunde stimmen')).toBeInTheDocument();
  });

  it('gives a row that fits NO tier no reason word at all', async () => {
    const untiered = {
      ...suggestMatches,
      candidates: [{ ...suggestMatches.candidates[0], kind: null, reason: null }],
    };
    await openAllocator({ ...HAPPY, suggest_payment_matches: ok(untiered) });
    await screen.findByText('R-2026-0002');
    // The vocabulary staying honest is its whole job: no tier means no word, not a softer word.
    expect(screen.queryByText('Betrag und Kunde stimmen')).not.toBeInTheDocument();
    expect(screen.queryByText(/Betrag ähnlich/)).not.toBeInTheDocument();
  });

  it('renders the remainder from the ENGINE, never from arithmetic of its own', async () => {
    await openAllocator();
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    // preview-payment.fixture.json is a fully allocated plan: remainderMinor === 0.
    expect(await within(dialog).findByText('Vollständig zugewiesen')).toBeInTheDocument();
  });

  it('discloses the legs with account NUMBER and label', async () => {
    await openAllocator();
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    // Scoped to the legs table by class: the Werkbank now carries three tables (candidates, the
    // Zuteilung statement, and the legs), and "1020 Bankkonto" is also the S9 picker's option label,
    // so a query that cannot tell them apart is not asserting the disclosure.
    const legs = await waitFor(() => {
      const table = dialog.querySelector('.pay-legs');
      if (table === null) throw new Error('legs table not rendered yet');
      return table as HTMLElement;
    });
    expect(within(legs).getByText('1020 Bankkonto')).toBeInTheDocument();
  });

  it('BLOCKED: a blocker still renders the plan, disables the confirm, and says WHY', async () => {
    await openAllocator({ ...HAPPY, preview_payment: ok(previewBlocked) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '900');

    const post = within(dialog).getByRole('button', { name: 'Zahlung buchen' });
    await waitFor(() => expect(post).toBeDisabled());
    // A disabled control without a visible reason is the logged defect class (D15/C3).
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    // The plan is still on screen: that is what makes a blocker different from a rejection. Scoped to
    // the legs table by class, since the Werkbank renders three tables (see the disclosure test).
    const legs = dialog.querySelector('.pay-legs') as HTMLElement;
    expect(within(legs).getByText('1020 Bankkonto')).toBeInTheDocument();
  });

  it('BLOCKED: the reason beside the confirm is INTERPOLATED, not a raw i18n token', async () => {
    // The browser flow found this line printing "Periode {period} ist gesperrt." verbatim while the
    // panel two elements above interpolated the same code correctly, because the inline reason
    // called `t(key)` with no parameters. Every parameterised blocker code was affected.
    const dialog = await openAllocator({ ...HAPPY, preview_payment: ok(previewBlocked) });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '900');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeDisabled(),
    );

    // preview-blocked.fixture.json carries the live `allocation_exceeds_open`, which takes three
    // parameters: the document number and both figures.
    const reason = dialog.querySelector('.pay-blocked-reason');
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent('R-2026-0003 ist nur noch mit CHF 250.00 offen, du weist CHF 900.00 zu.');
    // The i18n layer leaves an unfilled token visible on purpose, so this is the defect's signature.
    expect(reason?.textContent).not.toContain('{');
  });

  it('BLOCKED: the inline reason and the error panel are the SAME sentence, from one path', async () => {
    // The invariant behind the fix. Two interpolation paths for one code is the bug; asserting the
    // two renderings agree is what stops a second one being written back in.
    const dialog = await openAllocator({ ...HAPPY, preview_payment: ok(previewBlocked) });
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '900');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeDisabled(),
    );

    const panel = dialog.querySelector('.pay-error-message');
    const reason = dialog.querySelector('.pay-blocked-reason');
    expect(panel?.textContent).toBeTruthy();
    expect(reason?.textContent).toBe(panel?.textContent);
  });

  it('REFUSED: needs_fx_rate is a rate to record, offered as a recoverable state', async () => {
    await openAllocator({ ...HAPPY, preview_payment: reject(needsFxRate) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');

    // Names the pair and the date, exactly as the engine reported them. Scoped to the PANEL: the
    // inline reason beside the confirm now renders the identical sentence from the same path, so an
    // unscoped query would match two elements and stop asserting which one is which.
    await waitFor(() =>
      expect(dialog.querySelector('.pay-error-message')).toHaveTextContent(
        'Für EUR/CHF fehlt der Kurs vom 20.07.2026.',
      ),
    );
    // Not a dead end: it explains and offers the way out.
    expect(within(dialog).getByText(/Ohne Kurs wird nichts umgerechnet/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Kurs hinterlegen' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeDisabled(),
    );

    // The REFUSAL branch of the same line. It was the other half of the raw-token defect: a whole
    // rejection reached the inline reason with no parameters either.
    const reason = dialog.querySelector('.pay-blocked-reason');
    expect(reason).toHaveTextContent('Für EUR/CHF fehlt der Kurs vom 20.07.2026.');
    expect(reason?.textContent).not.toContain('{');
  });

  it('S9: names every account by NUMBER and NAME, and offers only the bank-and-cash range', async () => {
    // The browser flow found "1000 undefined" / "1020 undefined" here while this suite was green.
    // Asserting the rendered option TEXT is what catches it: a picker that reads a key the engine
    // does not send renders the number, a space, and the word `undefined`.
    await openAllocator();
    // Settled, not merely open: while `list_accounts` is out the same label wraps a disabled
    // placeholder select with one empty option, and sampling that under CPU starvation is a red
    // test about a picker nobody has rendered yet.
    const dialog = await settleAllocator(await screen.findByRole('dialog'));
    const picker = within(dialog).getByLabelText('Konto');
    await userEvent.click(picker);
    const options = screen.getAllByRole('option').map((option) => (option.textContent ?? '').replace('✓', '').trim());

    expect(options).toEqual(['1000 Kassenbestand', '1020 Bankkonto']);
    // Belt and braces, because `undefined` in an option is the exact shape of this defect class.
    expect(options.some((text) => text?.includes('undefined'))).toBe(false);
    // 3400 is income: the picker is bank and cash only, so the filter is asserted too.
    expect(options.some((text) => text?.startsWith('3400'))).toBe(false);
  });

  it('"Als Guthaben parken" reveals the Guthaben field and fills it with the remainder', async () => {
    // The browser flow measured the defect: the remainder text was identical before and after the
    // click, and the drawer inputs read the same six values either way. So the assertions are the
    // two halves of "visible change": no field before, a filled field after.
    await openAllocator({ ...HAPPY, preview_payment: ok(previewRemainder) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1081');
    // The Gegenpartei options arrive with the async `list_contacts` read: selecting before the
    // option exists throws, so the option is awaited as the proof the read landed.
    await userEvent.click(within(dialog).getByLabelText('Gegenpartei'));
    await userEvent.click(await screen.findByRole('option', { name: 'Beispiel GmbH' }));

    expect(within(dialog).queryByLabelText('Guthaben')).not.toBeInTheDocument();

    const park = await within(dialog).findByRole('button', { name: 'Als Guthaben parken' });
    await userEvent.click(park);

    // preview-remainder.fixture.json is the live engine's unspent plan: remainderMinor 108100.
    expect(await within(dialog).findByLabelText('Guthaben')).toHaveValue('1081.00');
    // The chip is spent: it revealed the field, so it is no longer offered beside it.
    expect(within(dialog).queryByRole('button', { name: 'Als Guthaben parken' })).not.toBeInTheDocument();
  });

  it('sends the parked Guthaben the field shows, so the wire and the screen agree', async () => {
    const posts: Record<string, unknown>[] = [];
    await openAllocator({
      ...HAPPY,
      preview_payment: ok(previewRemainder),
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1081');
    // Await the option: the Gegenpartei list arrives with the async `list_contacts` read.
    await userEvent.click(within(dialog).getByLabelText('Gegenpartei'));
    await userEvent.click(await screen.findByRole('option', { name: 'Beispiel GmbH' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Als Guthaben parken' }));
    await within(dialog).findByLabelText('Guthaben');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Zahlung buchen' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    // The figure on the wire is the figure in the field, in Rappen. A parked credit the operator
    // cannot see is exactly what this fix removes.
    expect(posts[0].onAccountMinor).toBe(108100);
  });

  it('P12b: a Guthaben needs an owner, so the chip is held with the reason beside it', async () => {
    await openAllocator({ ...HAPPY, preview_payment: ok(previewRemainder) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '1081');

    // No counterparty picked: the control is disabled BEFORE the click, and says why (D15/C3).
    const park = await within(dialog).findByRole('button', { name: 'Als Guthaben parken' });
    expect(park).toBeDisabled();
    expect(
      within(dialog).getByText('Ein Guthaben braucht einen Kunden. Wähl zuerst, von wem das Geld kommt.'),
    ).toBeInTheDocument();

    // Picking the owner releases it, and the reason goes away with the cause. The option is
    // awaited first: the Gegenpartei list arrives with the async `list_contacts` read.
    await userEvent.click(within(dialog).getByLabelText('Gegenpartei'));
    await userEvent.click(await screen.findByRole('option', { name: 'Beispiel GmbH' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Als Guthaben parken' })).toBeEnabled(),
    );
    expect(within(dialog).queryByText(/Ein Guthaben braucht einen Kunden/)).not.toBeInTheDocument();
  });

  it('S9 EMPTY: no bank account replaces the picker with a banner-CTA, not an empty select', async () => {
    await openAllocator({ ...HAPPY, list_accounts: ok({ accounts: [] }) });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Zuerst ein Bank- oder Kassenkonto hinterlegen.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Zur Einrichtung' })).toBeInTheDocument();
  });

  it('has no axe violations with the drawer open', async () => {
    // Settled, not merely open: see `settledAllocator`. The drawer's three reads have answered here,
    // so the pass audits the populated select and the candidate list a person actually reads.
    const { container } = renderPayments();
    await screen.findByText('Muster AG');
    await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
    await settleAllocator(await screen.findByRole('dialog'));
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- P9, the confirmation dialog -----------------------------------------------------------------

describe('P9: the confirmation dialog is presentation, and the intent is contract', () => {
  async function fillAndPost(canned: Canned) {
    renderPayments(canned);
    await screen.findByText('Muster AG');
    await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zahlung buchen' }));
  }

  it('asks before posting, and posts only on the deliberate second click', async () => {
    const posts: Record<string, unknown>[] = [];
    await fillAndPost({
      ...HAPPY,
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    });

    // The first click opens the question. Nothing has posted yet.
    expect(await screen.findByText(/Zahlung über CHF 500.00 buchen\?/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].intent).toBe('post_payment');
  });

  it('SUPPRESSED: skips the dialog and STILL sends the intent, which is the whole of P9', async () => {
    const posts: Record<string, unknown>[] = [];
    const canned: Canned = {
      ...HAPPY,
      record_payment: (input) => {
        posts.push(input);
        return ok(recordPayment);
      },
    };

    // The operator ticks "nicht mehr anzeigen" on the first post.
    await fillAndPost(canned);
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByLabelText('Nicht mehr anzeigen'));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    // A fresh mount, so the second render is unambiguous. The in-memory localStorage installed in
    // beforeEach SURVIVES the unmount, which is exactly the persistence being asserted.
    cleanup();
    await fillAndPost(canned);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts[1].intent).toBe('post_payment');
    expect(posts[1].intent).toBe(posts[0].intent);
  });

  it('preserves every typed value when the post is rejected', async () => {
    await fillAndPost({ ...HAPPY, record_payment: reject({ error: 'period_locked', period: '2026-07' }) });
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Zahlung buchen' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Periode 2026-07 ist gesperrt/)).toBeInTheDocument();
    // The amount survives, so the user retries rather than retypes money (A10-G9's class).
    expect(within(dialog).getByLabelText('Betrag')).toHaveValue('500');
    expect(within(dialog).getByRole('link', { name: 'Perioden öffnen' })).toBeInTheDocument();
  });
});

// --- the idempotency key is an answer to the QUESTION, not to the mount ---------------------------
//
// The same defect A19 was found to carry twice, here in the one drawer A14 writes money from. The
// key was minted once in a ref at mount and reused for the life of the drawer, on a comment that
// justified it against a retry of the SAME question and said nothing about a retry of a CHANGED
// one. This drawer creates that second case on purpose: a rejected post preserves every typed value
// so the operator can edit and click again, which the test directly above pins.
//
// The engine does NOT catch it. `recordPayment` folds only `direction`, `date` and `amountMinor`
// into its memo key (`scopedPaymentKey`, `src/core/payments/payment.ts`), and `allocatePayment`
// folds nothing but the payment id, so a changed ALLOCATION under a recorded key hits
// `recallIdempotent` and is answered with the FIRST plan. The stronger `idempotency_key_conflict`
// refusal sits BELOW that replay and never runs.
//
// The world both tests are set in is the one the ref exists for: a post that LANDED whose response
// was lost. `fetchTransport` and `mcpTransport` both surface that as a `transport_error` Result
// rather than a throw, so the drawer shows a refusal over a payment the engine has already written.
describe('the idempotency key is derived from the question, not minted at mount', () => {
  /** Open the drawer, name the money, and put an allocation on the first candidate row. */
  async function openWithAllocation(canned: Canned): Promise<HTMLElement> {
    // P9's dialog is presentation and this is a test about the wire, so it is suppressed rather
    // than clicked through twice. The intent on the wire is asserted by the suite above either way.
    setConfirmPostSuppressed('ws_test', true);
    renderPayments(canned);
    await screen.findByText('Muster AG');
    await userEvent.click(screen.getByRole('button', { name: 'Zahlung erfassen' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Betrag'), '500');
    // R-2026-0002, the exact-amount candidate. Its row input is the first "Zuweisen" in the drawer.
    const allocation = (await within(dialog).findAllByLabelText('Zuweisen'))[0];
    await userEvent.type(allocation, '500');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeEnabled(),
    );
    return dialog;
  }

  it('mints a NEW key once the allocation changes, so a lost response cannot replay the first plan', async () => {
    const sent: Array<{ allocations: unknown; idempotencyKey: unknown }> = [];
    const dialog = await openWithAllocation({
      ...HAPPY,
      record_payment: (input) => {
        sent.push({ allocations: input.allocations, idempotencyKey: input.idempotencyKey });
        return sent.length === 1 ? reject({ error: 'transport_error' }, 500) : ok(recordPayment);
      },
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(sent).toHaveLength(1));

    // The payment landed and the answer was lost. The operator, told it failed, splits the money
    // differently and posts again. Every value is still on screen, which is what makes this the
    // ordinary path rather than an exotic one.
    const allocation = (await within(dialog).findAllByLabelText('Zuweisen'))[0];
    await userEvent.clear(allocation);
    await userEvent.type(allocation, '250');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Zahlung buchen' })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zahlung buchen' }));
    await waitFor(() => expect(sent).toHaveLength(2));

    // Two DIFFERENT plans went out, which is the premise: this is not a retry.
    expect(
      sent.map((call) => (call.allocations as { amountMinor: number }[])[0].amountMinor),
    ).toEqual([50000, 25000]);
    // Under one key the second is a replay: the engine answers `ok` with the CHF 500.00 allocation
    // and the drawer closes reporting a success on a split nobody chose.
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
  });

  it('keeps ONE key across a retry of the SAME question, so a transport failure cannot post twice', async () => {
    // The property the ref was minted for, which the fix must not trade away.
    const keys: unknown[] = [];
    const dialog = await openWithAllocation({
      ...HAPPY,
      record_payment: (input) => {
        keys.push(input.idempotencyKey);
        return keys.length === 1 ? reject({ error: 'transport_error' }, 500) : ok(recordPayment);
      },
    });

    const post = within(dialog).getByRole('button', { name: 'Zahlung buchen' });
    await userEvent.click(post);
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.click(post);
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(typeof keys[0]).toBe('string');
    expect(keys[1]).toBe(keys[0]);
  });
});
