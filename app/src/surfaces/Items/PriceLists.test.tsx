/**
 * The Preislisten tab (D00 US-D00.4): the suite `PriceLists.tsx` shipped without.
 *
 * `PriceLists.tsx` landed on `develop` as 281 lines of new component with no component test at all,
 * so the tab, the create-list form, the append-only price editor and the `price_resolve` preview were
 * all reachable and none of them were held to anything.
 *
 * DRIVEN THROUGH THE ROUTED SURFACE, not by mounting `PriceLists` directly. The tab gets its
 * `items` and `baseCurrency` from `Items.tsx`, so mounting the child with hand-passed props would
 * test a wiring that does not exist: the interesting question is what the operator sees after
 * clicking Preislisten, and that includes whether the parent hands the loaded catalog down.
 *
 * THE PRECEDENCE IS THE ENGINE'S, AND THE PREVIEW MUST NOT RE-DERIVE IT. `resolvePrice`
 * (`src/core/sales/priceLists.ts`) is the single resolver: contact, then segment, then the item base
 * price, latest `valid_from <= at` within a scope. The tab's job is to ask and to render the answer,
 * including the answer's own currency, so the tests below feed a `price_resolve` answer that
 * deliberately disagrees with both the item row and the workspace base currency. A component that
 * decided any of it locally would agree with an echoing fake for ever.
 *
 * PANEL-SCOPED QUERIES. The tab renders `Artikel` as a field label twice (the price editor and the
 * preview) and `Kunde` twice once the scope select is on contact, so a bare `getByLabelText` is
 * ambiguous by construction. `panel()` narrows to the section under test, the same move as
 * `.closest('tr')` in `BankAccounts.test.tsx`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { hang, watchReads } from '../../test-transport';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Items from './index';

/** A canned handler exactly as the transport calls it: the request input in, a RestResponse out. */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422, extra: Record<string, unknown> = {}): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/** The catalog the tab's two item pickers are filled from, and the source of the row names. */
const ITEMS = [
  { id: 'i1', name: 'Beratung', defaultUnitPriceMinor: 15000, currency: 'CHF', unit: 'hour' },
  { id: 'i2', name: 'Workshop', defaultUnitPriceMinor: 120000, currency: 'CHF', unit: 'day' },
];

/** One contact-scoped list and one segment-scoped list: the XOR the engine enforces, both arms. */
const LISTS = [
  { id: 'pl_meier', name: 'Meier AG', contactId: 'c_meier', segment: null },
  { id: 'pl_wv', name: 'Wiederverkauf', contactId: null, segment: 'Wiederverkäufer' },
];

/**
 * The contact register the scope picker is filled from.
 *
 * `c_meier` deliberately ALREADY holds a list (see `LISTS`), so the picker's disabled arm has a real
 * subject: one scope holds at most one list (F4, `scope_taken`), and offering a contact that already
 * has one is offering a call the engine refuses.
 */
const CONTACTS = [
  { id: 'c_meier', name: 'Meier AG' },
  { id: 'c_huber', name: 'Huber GmbH' },
];

const HAPPY: Canned = {
  list_items: ok({ items: ITEMS }),
  list_accounts: ok({ accounts: listAccountsFixture.accounts }),
  vat_codes: ok({ taxCodes: [] }),
  get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
  item_categories_list: ok({ categories: [] }),
  list_contacts: ok({ contacts: CONTACTS }),
  price_lists_list: ok({ priceLists: LISTS }),
  price_lists_get: ok({ prices: [] }),
};

interface RenderOptions {
  workspaceId?: string | null;
  transport?: Transport;
}

function renderItems(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const { workspaceId = 'ws_test', transport } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Items />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/**
 * Render, wait for the catalog read to settle, and switch to Preislisten.
 *
 * The tabs only exist once `Items.tsx` is past its skeleton, so waiting for the tab itself is the
 * settle condition: it is present in every branch this file exercises, empty catalog included.
 */
async function openPriceLists(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const view = renderItems(canned, options);
  // The Katalog/Preislisten switch is the shared WAI-ARIA Tabs now (D118 B2): a real tablist, so the
  // switch is a `role="tab"`, not the old `aria-pressed` toggle button.
  await userEvent.click(await screen.findByRole('tab', { name: 'Preislisten' }));
  return view;
}

/**
 * Real content on screen AND nothing still announcing itself busy, the twin of the helper in
 * `Items.test.tsx` and `BankAccounts.test.tsx`.
 *
 * AXE MUST RUN ON A SETTLED SURFACE: auditing the first frame audits the skeleton, which has no
 * forms, no pressed states and no roles to get wrong, so it passes whatever the finished render
 * would have failed. The wait lives in this helper rather than inline in the audit blocks on
 * purpose, exactly as it does in the two neighbouring suites: an inline `aria-busy` assertion is
 * what `loading-state-convention.test.ts` classifies as a LOADING-state claim, and these two blocks
 * make no claim about loading at all.
 */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findAllByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

/** Narrow to one section of the tab. Throws rather than letting a query run against the document. */
function panel(container: HTMLElement, name: 'create' | 'prices' | 'resolve'): HTMLElement {
  const found = container.querySelector(`.pricelists-${name}`);
  if (found === null) throw new Error(`the Preislisten tab has no .pricelists-${name} panel on screen`);
  return found as HTMLElement;
}

/** Select one price list by name and wait for its price rows to be asked for. */
async function selectList(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name }));
  await screen.findByRole('heading', { name: 'Preise' });
}

// --- the tab itself -------------------------------------------------------------------------------

describe('Items, the Preislisten tab', () => {
  it('switches away from the catalog and reads the price lists for THIS workspace', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ priceLists: LISTS }));
    await openPriceLists({ ...HAPPY, price_lists_list: listSpy });

    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(listSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test' });
    // The tab really replaced the catalog: its search control is gone, not merely covered.
    expect(screen.queryByPlaceholderText('Artikel suchen')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Preisliste anlegen' })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected so the state is not carried by colour alone', async () => {
    await openPriceLists();

    // The shared Tabs primitive is a WAI-ARIA tablist (D118 B2): the selected tab is carried by
    // `aria-selected` on a `role="tab"`, the successor to the old `aria-pressed` toggle buttons.
    expect(screen.getByRole('tab', { name: 'Preislisten' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Katalog' })).toHaveAttribute('aria-selected', 'false');
  });

  it('withdraws the catalog primary action, which cannot act on a price list', async () => {
    await openPriceLists();
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });

    expect(screen.queryByRole('button', { name: 'Neuer Artikel' })).not.toBeInTheDocument();
  });

  it('LOADING: a skeleton while the read is in flight, and no empty state claiming there are none', async () => {
    // CHANGED 2026-07-30. This block used to note that the tab "has no busy region of its own" and
    // assert the create form was on screen mid-read. That was the defect: with no loading state,
    // `lists.length === 0` rendered "Noch keine Preislisten" WHILE the read was still in flight, which
    // is the opposite of what was true. The read proof stays (see loading-state-convention.test.ts).
    const transport = watchReads(hang('price_lists_list', fakeTransport(HAPPY)));
    const { container } = await openPriceLists(HAPPY, { transport });

    await transport.started('price_lists_list');
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByText('Noch keine Preislisten.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Preisliste anlegen' })).not.toBeInTheDocument();
  });

  it('EMPTY: says what a price list is for rather than a bare "no data"', async () => {
    await openPriceLists({ ...HAPPY, price_lists_list: ok({ priceLists: [] }) });

    expect(await screen.findByText('Noch keine Preislisten.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Eine Preisliste enthält kunden- oder segmentspezifische Preise; ohne sie gilt der Basispreis des Artikels.',
      ),
    ).toBeInTheDocument();
  });

  it('POPULATED: renders each list with the scope it is actually bound to', async () => {
    await openPriceLists();

    const contactRow = (await screen.findByRole('button', { name: 'Meier AG' })).closest('li') as HTMLElement;
    expect(within(contactRow).getByText('Kunde')).toBeInTheDocument();
    // CHANGED 2026-07-30: the scope value is the contact's NAME now, not the raw `c_meier` id the
    // operator never chose and cannot read. The id is still the fallback when the register is unreadable.
    expect(contactRow.querySelector('.item-unit')?.textContent).toBe('Meier AG');

    const segmentRow = screen.getByRole('button', { name: 'Wiederverkauf' }).closest('li') as HTMLElement;
    expect(within(segmentRow).getByText('Segment')).toBeInTheDocument();
    expect(within(segmentRow).getByText('Wiederverkäufer')).toBeInTheDocument();
    // A populated register never also claims to be empty.
    expect(screen.queryByText('Noch keine Preislisten.')).not.toBeInTheDocument();
  });

  it('ERROR: a rejected read is reported, and the tab does NOT also claim to be empty', async () => {
    await openPriceLists({ ...HAPPY, price_lists_list: reject('invalid_input') });

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Eine Eingabe war ungültig. Bitte prüfe die Felder und versuche es erneut.'),
    ).toBeInTheDocument();
    // CHANGED 2026-07-30: this second half is new. "We could not read your price lists" and "you have
    // no price lists" are opposite facts, and the tab used to render both at once, side by side.
    expect(screen.queryByText('Noch keine Preislisten.')).not.toBeInTheDocument();
  });

  it('DENIED: a padlock panel, not a banner, and no form the operator cannot use', async () => {
    // CHANGED 2026-07-30. This block used to assert the GENERIC banner sentence, because the padlock
    // panel was unreachable from this tab: `Items.tsx` inspects only `list_items` for
    // `permission_denied`, and `price_lists_list` gates on `read_master_data` just like it does.
    const { container } = await openPriceLists({ ...HAPPY, price_lists_list: reject('permission_denied', 403) });

    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Preisliste anlegen' })).not.toBeInTheDocument();
    expect(screen.queryByText('Noch keine Preislisten.')).not.toBeInTheDocument();
    expect(container.querySelector('.error-banner')).toBeNull();
  });

  it('has no axe violations on the settled, populated tab', async () => {
    const { container } = await openPriceLists();
    await settled(container, 'Meier AG');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with a list selected and its price editor open', async () => {
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_get: ok({ prices: [{ id: 'p1', itemId: 'i1', priceMinor: 13500, currency: 'CHF', validFrom: '2026-01-01' }] }),
    });
    await selectList('Meier AG');
    await settled(container, 'Preise');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// --- creating a list ------------------------------------------------------------------------------

describe('Preislisten, creating a list', () => {
  it('sends a SEGMENT scope with no contactId at all, which is the XOR the engine enforces', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ priceList: { id: 'pl_new' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Grosshandel');
    await userEvent.type(within(create).getByLabelText('Segment'), 'Wiederverkäufer');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    const sent = upsertSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', name: 'Grosshandel', segment: 'Wiederverkäufer' });
    // `scope_ambiguous` is returned when BOTH arms are set, so the unused one must not be sent.
    expect(sent.contactId).toBeUndefined();
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(String(sent.idempotencyKey).length).toBeGreaterThan(0);
  });

  it('sends a CONTACT scope with no segment, PICKED from the register rather than typed as an id', async () => {
    // CHANGED 2026-07-30: the contact arm used to be a free-text id field, so creating a customer price
    // list meant knowing a `c_...` id by heart. It is a picker over `list_contacts` now.
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ priceList: { id: 'pl_new' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.click(within(create).getByRole('combobox', { name: 'Geltungsbereich' }));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde' }));
    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Huber Spezial');
    await userEvent.click(within(create).getByRole('combobox', { name: 'Kunde' }));
    await userEvent.click(screen.getByRole('option', { name: 'Huber GmbH' }));
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    const sent = upsertSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', name: 'Huber Spezial', contactId: 'c_huber' });
    expect(sent.segment).toBeUndefined();
  });

  it('DISABLES a contact that already has a list, and says so in the option itself', async () => {
    // One scope holds at most one list (F4). `c_meier` has one in the fixture, so offering it would be
    // offering a call the engine refuses with `scope_taken`: a dead end, one click deep.
    const { container } = await openPriceLists();
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.click(within(create).getByRole('combobox', { name: 'Geltungsbereich' }));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde' }));
    await userEvent.click(within(create).getByRole('combobox', { name: 'Kunde' }));
    const listbox = screen.getByRole('listbox', { name: 'Kunde' });

    const taken = within(listbox).getByRole('option', { name: 'Meier AG (hat schon eine Preisliste)' });
    expect(taken).toHaveAttribute('aria-disabled', 'true');
    // The reason is IN the option text, not colour or position: a disabled option with no explanation
    // reads as a bug.
    expect(within(listbox).getByRole('option', { name: 'Huber GmbH' })).not.toHaveAttribute('aria-disabled');
  });

  it('degrades to a typed contact id when the contact register cannot be read at all (P9)', async () => {
    // The contact register is a separate right and a separate capability's surface. Losing it must not
    // take this tab down, and must not leave the contact arm as an empty picker with no way forward.
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ priceList: { id: 'pl_new' } }));
    const { container } = await openPriceLists({
      ...HAPPY,
      list_contacts: reject('permission_denied', 403),
      price_lists_upsert: upsertSpy,
    });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.click(within(create).getByRole('combobox', { name: 'Geltungsbereich' }));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde' }));
    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Direkt');
    await userEvent.type(within(create).getByLabelText('Kunde'), 'c_direkt');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ contactId: 'c_direkt' });
  });

  it('trims the typed name and scope value rather than storing the operator whitespace', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ priceList: { id: 'pl_new' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), '  Grosshandel  ');
    await userEvent.type(within(create).getByLabelText('Segment'), '  Wiederverkäufer  ');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      name: 'Grosshandel',
      segment: 'Wiederverkäufer',
    });
  });

  it('re-reads the lists after a create, so the new list appears without a reload', async () => {
    let listCalls = 0;
    await openPriceLists({
      ...HAPPY,
      price_lists_list: () => {
        listCalls += 1;
        return ok({ priceLists: listCalls === 1 ? [] : [{ id: 'pl_new', name: 'Grosshandel', segment: 'Wiederverkäufer' }] });
      },
      price_lists_upsert: ok({ priceList: { id: 'pl_new' } }),
    });

    expect(await screen.findByText('Noch keine Preislisten.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Bezeichnung'), 'Grosshandel');
    await userEvent.type(screen.getByLabelText('Segment'), 'Wiederverkäufer');
    await userEvent.click(screen.getByRole('button', { name: 'Preisliste anlegen' }));

    expect(await screen.findByRole('button', { name: 'Grosshandel' })).toBeInTheDocument();
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Noch keine Preislisten.')).not.toBeInTheDocument();
  });

  it('clears the form after a create, so the next list does not inherit the last one name', async () => {
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: ok({ priceList: { id: 'pl_new' } }) });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Grosshandel');
    await userEvent.type(within(create).getByLabelText('Segment'), 'Wiederverkäufer');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    await waitFor(() => expect(within(create).getByLabelText('Bezeichnung')).toHaveValue(''));
    expect(within(create).getByLabelText('Segment')).toHaveValue('');
  });

  it('is honestly DISABLED with the precondition inline, never enabled and inert (D15/C3)', async () => {
    // CHANGED 2026-07-30. This block used to click an ENABLED button twice and assert nothing happened,
    // with a note that what the operator is told was "a separate matter". It was the defect: an enabled
    // primary that does nothing and says nothing is the one outcome the canon has no name for, and
    // D15/C3 is the decided answer. The write assertion survives; the button is now disabled with the
    // FIRST missing precondition beside it, because a person fixes them in order.
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ priceList: { id: 'pl_new' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');
    const button = within(create).getByRole('button', { name: 'Preisliste anlegen' });

    expect(button).toBeDisabled();
    const nameNote = within(create).getByText('Gib der Preisliste einen Namen.');
    // BOUND to the control, not merely nearby: a note nothing points at is invisible to a screen reader.
    expect(button.getAttribute('aria-describedby')).toBe(nameNote.id);

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Grosshandel');
    expect(button).toBeDisabled();
    expect(within(create).getByText('Gib das Segment an, für das die Liste gilt.')).toBeInTheDocument();
    expect(within(create).queryByText('Gib der Preisliste einen Namen.')).not.toBeInTheDocument();

    await userEvent.type(within(create).getByLabelText('Segment'), 'Wiederverkäufer');
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-describedby');
    await userEvent.click(button);
    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
  });

  it('names the CONTACT precondition rather than the segment one once the scope switches', async () => {
    // The two arms are different questions, so one shared "fill this in" would be worse than nothing.
    const { container } = await openPriceLists();
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Meier Spezial');
    await userEvent.click(within(create).getByRole('combobox', { name: 'Geltungsbereich' }));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde' }));

    expect(within(create).getByText('Wähle den Kunden, für den die Liste gilt.')).toBeInTheDocument();
    expect(within(create).queryByText('Gib das Segment an, für das die Liste gilt.')).not.toBeInTheDocument();
  });

  it('keeps the typed values when the engine refuses, and NAMES the refusal', async () => {
    // CHANGED 2026-07-30: the `allowConsole(/missing translation for "errors.scope_ambiguous"/)` this
    // block carried is gone, because the key exists. The i18n miss was not the whole cost: an unmapped
    // code is `reportable` to `ErrorBanner` (D48), so a correct rejection came with a bug-report button.
    const { container } = await openPriceLists({ ...HAPPY, price_lists_upsert: reject('scope_ambiguous') });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Grosshandel');
    await userEvent.type(within(create).getByLabelText('Segment'), 'Wiederverkäufer');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Eine Preisliste gilt entweder für einen Kunden oder für ein Segment/))
      .toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Diesen Fehler melden' })).not.toBeInTheDocument();
    expect(within(create).getByLabelText('Bezeichnung')).toHaveValue('Grosshandel');
    expect(within(create).getByLabelText('Segment')).toHaveValue('Wiederverkäufer');
  });
});

// --- the price rows -------------------------------------------------------------------------------

describe('Preislisten, the append-only price rows', () => {
  const PRICES = ok({
    prices: [
      { id: 'p1', itemId: 'i1', priceMinor: 13500, currency: 'CHF', validFrom: '2026-01-01' },
      { id: 'p2', itemId: 'i1', priceMinor: 12000, currency: 'CHF', validFrom: '2025-07-01' },
    ],
  });

  it('reads the selected list prices and renders each row as name, money and Swiss date', async () => {
    const getSpy = vi.fn<CannedHandler>(() => PRICES);
    await openPriceLists({ ...HAPPY, price_lists_get: getSpy });
    await selectList('Meier AG');

    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    expect(getSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', priceListId: 'pl_meier' });
    // The item NAME, resolved from the catalog the parent handed down, never the raw id.
    expect(screen.getAllByText('Beratung').length).toBeGreaterThan(0);
    // Both history rows survive: a price list is append-only, so the superseded row is not hidden.
    expect(screen.getByText('CHF 135.00')).toBeInTheDocument();
    expect(screen.getByText('CHF 120.00')).toBeInTheDocument();
    // Swiss display (D15/C1), not the ISO string the engine sent.
    expect(screen.getByText('01.01.2026')).toBeInTheDocument();
    expect(screen.getByText('01.07.2025')).toBeInTheDocument();
  });

  it('renders a price row in the currency the ENGINE stored, not the workspace base currency', async () => {
    // `price_list_item.currency` is its own column: a list may price an item in a currency the
    // workspace does not keep its books in, and reading that row as francs would be a wrong number.
    await openPriceLists({
      ...HAPPY,
      price_lists_get: ok({ prices: [{ id: 'p1', itemId: 'i1', priceMinor: 9900, currency: 'EUR', validFrom: '2026-01-01' }] }),
    });
    await selectList('Meier AG');

    expect(await screen.findByText('EUR 99.00')).toBeInTheDocument();
    expect(screen.queryByText('CHF 99.00')).not.toBeInTheDocument();
  });

  it('falls back to the raw item id for a price row whose item is not in the loaded catalog', async () => {
    // An archived or filtered-out item still has price history. Rendering `undefined` there is the
    // failure mode this branch exists to avoid.
    await openPriceLists({
      ...HAPPY,
      price_lists_get: ok({ prices: [{ id: 'p1', itemId: 'i_gone', priceMinor: 5000, currency: 'CHF', validFrom: '2026-01-01' }] }),
    });
    await selectList('Meier AG');

    expect(await screen.findByText('i_gone')).toBeInTheDocument();
  });

  it('closes the price editor when the same list is pressed again', async () => {
    await openPriceLists({ ...HAPPY, price_lists_get: PRICES });
    await selectList('Meier AG');
    // K-22: the list whose prices show is the CURRENT row, announced with aria-current.
    expect(screen.getByRole('button', { name: 'Meier AG' })).toHaveAttribute('aria-current', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Meier AG' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Preise' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Meier AG' })).not.toHaveAttribute('aria-current');
  });

  it('sets a price as integer Rappen against the selected list, never a float', async () => {
    const setSpy = vi.fn<CannedHandler>(() => ok({ priceListItem: { id: 'p9' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_set_price: setSpy });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), '99.50');
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));

    await waitFor(() => expect(setSpy).toHaveBeenCalledOnce());
    const sent = setSpy.mock.calls[0][0];
    expect(sent).toMatchObject({
      workspaceId: 'ws_test',
      priceListId: 'pl_meier',
      itemId: 'i1',
      priceMinor: 9950,
      validFrom: '2026-03-01',
    });
    expect(Number.isInteger(sent.priceMinor)).toBe(true);
    expect(typeof sent.idempotencyKey).toBe('string');
  });

  it('parses an apostrophe-grouped Swiss amount exactly, with no binary float in the middle', async () => {
    const setSpy = vi.fn<CannedHandler>(() => ok({ priceListItem: { id: 'p9' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_set_price: setSpy });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Workshop' }));
    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), "1'234.55");
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));

    await waitFor(() => expect(setSpy).toHaveBeenCalledOnce());
    expect(setSpy.mock.calls[0][0]).toMatchObject({ itemId: 'i2', priceMinor: 123455 });
  });

  it('ACCEPTS a Swiss comma decimal, and refuses only what is genuinely not an amount', async () => {
    // CHANGED 2026-07-30. This block used to assert that `12,50` was REFUSED, which was the shipped
    // behaviour and the defect: a Swiss keyboard writes 12,50 as readily as 12.50, and the button went
    // dead on it while staying enabled and saying nothing. `parseAmountToMinor` now swaps a lone comma
    // for a period, and only where it cannot mean anything else, so `1,234` (a thousand in English, one
    // point two three four in German) is still refused rather than guessed at.
    const setSpy = vi.fn<CannedHandler>(() => ok({ priceListItem: { id: 'p9' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_set_price: setSpy });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');

    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), '12,50');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledOnce());
    // The SAME Rappen the dot form sends: the comma is read, never coerced through a float.
    expect(setSpy.mock.calls[0][0]).toMatchObject({ priceMinor: 1250 });

    // Everything that is not an amount, or is ambiguous, leaves the control honestly disabled with the
    // reason beside it (D15/C3) rather than enabled and inert.
    for (const bad of ['12.505', 'gratis', '-5', '1,234', '1,2,3']) {
      await userEvent.clear(within(prices).getByLabelText('Verkaufspreis'));
      await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), bad);
      expect(within(prices).getByRole('button', { name: 'Preis festlegen' }), bad).toBeDisabled();
      expect(within(prices).getByText('Gib einen Betrag ein, z. B. 150.50 oder 150,50.')).toBeInTheDocument();
    }
    expect(setSpy).toHaveBeenCalledOnce();
  });

  it('never sends a price with no item or no validFrom, which the engine would reject', async () => {
    const setSpy = vi.fn<CannedHandler>(() => ok({ priceListItem: { id: 'p9' } }));
    const { container } = await openPriceLists({ ...HAPPY, price_lists_set_price: setSpy });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    // No item chosen.
    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), '10');
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));
    expect(setSpy).not.toHaveBeenCalled();

    // Item chosen, validFrom cleared: `valid_from` is what makes the history resolvable, so a row
    // without one has no meaning at all.
    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.clear(within(prices).getByLabelText('Gültig ab'));
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));
    expect(setSpy).not.toHaveBeenCalled();

    // Both present: the write happens, so the two refusals above are the guard and not a dead button.
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledOnce());
  });

  it('re-reads the rows after a set and clears only the amount, keeping the validFrom date', async () => {
    // Seeding several items at one Gültig-ab date is the normal way a list is filled, so the date
    // survives the write on purpose and only the amount resets.
    let getCalls = 0;
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_get: () => {
        getCalls += 1;
        return getCalls === 1
          ? ok({ prices: [] })
          : ok({ prices: [{ id: 'p9', itemId: 'i1', priceMinor: 9950, currency: 'CHF', validFrom: '2026-03-01' }] });
      },
      price_lists_set_price: ok({ priceListItem: { id: 'p9' } }),
    });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), '99.50');
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));

    expect(await screen.findByText('CHF 99.50')).toBeInTheDocument();
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(within(prices).getByLabelText('Verkaufspreis')).toHaveValue('');
    expect(within(prices).getByLabelText('Gültig ab')).toHaveValue('2026-03-01');
  });

  it('reports a refused set_price by NAME and keeps the amount for the correction', async () => {
    // CHANGED 2026-07-30: `errors.invalid_price` exists, so the stale `allowConsole` is gone.
    const { container } = await openPriceLists({ ...HAPPY, price_lists_set_price: reject('invalid_price') });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.type(within(prices).getByLabelText('Verkaufspreis'), '99.50');
    await userEvent.type(within(prices).getByLabelText('Gültig ab'), '2026-03-01');
    await userEvent.click(within(prices).getByRole('button', { name: 'Preis festlegen' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Dieser Preis ist ungültig/)).toBeInTheDocument();
    expect(within(prices).getByLabelText('Verkaufspreis')).toHaveValue('99.50');
  });

  it('reports a refused price_lists_get instead of showing an empty price history', async () => {
    await openPriceLists({ ...HAPPY, price_lists_get: reject('not_found') });
    await userEvent.click(await screen.findByRole('button', { name: 'Meier AG' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

// --- the price_resolve preview --------------------------------------------------------------------

describe('Preislisten, the price_resolve preview', () => {
  it('asks the engine for the contact price and renders its answer and its source', async () => {
    const resolveSpy = vi.fn<CannedHandler>(() =>
      ok({ priceMinor: 13500, currency: 'CHF', source: 'contact', priceListId: 'pl_meier' }),
    );
    const { container } = await openPriceLists({ ...HAPPY, price_resolve: resolveSpy });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    // CHANGED 2026-07-30: the contact field is a picker over `list_contacts` now, not a typed id.
    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Kunde' }));
    await userEvent.click(screen.getByRole('option', { name: 'Meier AG' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    await waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
    expect(resolveSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      itemId: 'i1',
      contactId: 'c_meier',
    });
    expect(await within(resolve).findByText('CHF 135.00')).toBeInTheDocument();
    expect(within(resolve).getByText('Kundenpreis')).toBeInTheDocument();
  });

  it('omits contactId entirely when no contact is named, which is the base tier', async () => {
    const resolveSpy = vi.fn<CannedHandler>(() => ok({ priceMinor: 15000, currency: 'CHF', source: 'base' }));
    const { container } = await openPriceLists({ ...HAPPY, price_resolve: resolveSpy });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    await waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
    expect(resolveSpy.mock.calls[0][0].contactId).toBeUndefined();
    expect(await within(resolve).findByText('Basispreis')).toBeInTheDocument();
  });

  it('labels a segment hit as the Segmentpreis, so the precedence tier is visible', async () => {
    const { container } = await openPriceLists({
      ...HAPPY,
      price_resolve: ok({ priceMinor: 14000, currency: 'CHF', source: 'segment', priceListId: 'pl_wv' }),
    });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Kunde' }));
    await userEvent.click(screen.getByRole('option', { name: 'Meier AG' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    expect(await within(resolve).findByText('Segmentpreis')).toBeInTheDocument();
    expect(within(resolve).getByText('CHF 140.00')).toBeInTheDocument();
  });

  it('renders the resolved price in the currency the ANSWER carries, never the workspace base', async () => {
    // The tab's `baseCurrency` prop is the fallback for an answer with no currency, not an override.
    // A EUR list price read as francs is exactly the class of defect `formatMoney` lost its default over.
    const { container } = await openPriceLists({
      ...HAPPY,
      price_resolve: ok({ priceMinor: 9900, currency: 'EUR', source: 'contact' }),
    });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    expect(await within(resolve).findByText('EUR 99.00')).toBeInTheDocument();
    expect(within(resolve).queryByText('CHF 99.00')).not.toBeInTheDocument();
  });

  it('PICKS the contact from the register rather than asking for an id to be typed', async () => {
    // CHANGED 2026-07-30: this block used to type `  c_meier  ` and assert the trim, which only made
    // sense while the field was a free-text id. It is a picker now; the trim is asserted below on the
    // degraded path, which is the only path where an operator can still type one.
    const resolveSpy = vi.fn<CannedHandler>(() => ok({ priceMinor: 13500, currency: 'CHF', source: 'contact' }));
    const { container } = await openPriceLists({ ...HAPPY, price_resolve: resolveSpy });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Kunde' }));
    await userEvent.click(screen.getByRole('option', { name: 'Meier AG' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    await waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
    expect(resolveSpy.mock.calls[0][0]).toMatchObject({ contactId: 'c_meier' });
  });

  it('still trims a TYPED contact id on the degraded path, and reads whitespace as no contact', async () => {
    // CHANGED 2026-07-30: re-pointed at the path where a contact id is still typed at all, which is the
    // one where `list_contacts` could not be read. The two claims are unchanged.
    const resolveSpy = vi.fn<CannedHandler>(() => ok({ priceMinor: 15000, currency: 'CHF', source: 'base' }));
    const { container } = await openPriceLists({
      ...HAPPY,
      list_contacts: reject('permission_denied', 403),
      price_resolve: resolveSpy,
    });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');
    const field = within(resolve).getByLabelText('Kunde');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.type(field, '  c_meier  ');
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
    expect(resolveSpy.mock.calls[0][0]).toMatchObject({ contactId: 'c_meier' });

    // Whitespace is NOT a contact: sending it would ask the engine for a contact that cannot exist and
    // get `not_found` where the operator meant the base tier.
    await userEvent.clear(field);
    await userEvent.type(field, '   ');
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(2));
    expect(resolveSpy.mock.calls[1][0].contactId).toBeUndefined();
  });

  it('asks for nothing while no item is chosen', async () => {
    const resolveSpy = vi.fn<CannedHandler>(() => ok({ priceMinor: 1, currency: 'CHF', source: 'base' }));
    const { container } = await openPriceLists({ ...HAPPY, price_resolve: resolveSpy });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.type(within(resolve).getByLabelText('Kunde'), 'c_meier');
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('drops the previous figure when the next preview is refused, so no stale price is read as current', async () => {
    // THE ONE THAT MATTERS. A quoted price left on screen after the engine refused to quote it is a
    // wrong number a person would act on, and it is one missing `setResolveResult(null)` away.
    //
    // CHANGED 2026-07-30: `item_archived`, the engine's refusal for quoting a dead SKU, now has its own
    // message, so the stale `allowConsole` is gone and the sentence itself is asserted below.
    let calls = 0;
    const { container } = await openPriceLists({
      ...HAPPY,
      price_resolve: () => {
        calls += 1;
        return calls === 1
          ? ok({ priceMinor: 15000, currency: 'CHF', source: 'base' })
          : reject('item_archived');
      },
    });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));
    expect(await within(resolve).findByText('CHF 150.00')).toBeInTheDocument();

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Workshop' }));
    await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Dieser Artikel ist archiviert/)).toBeInTheDocument();
    expect(within(resolve).queryByText('CHF 150.00')).not.toBeInTheDocument();
  });

  it('offers every loaded item in both pickers, so the tab can price the whole catalog', async () => {
    const { container } = await openPriceLists();
    await selectList('Meier AG');

    for (const section of ['prices', 'resolve'] as const) {
      const picker = within(panel(container, section)).getByRole('combobox', { name: 'Artikel' });
      await userEvent.click(picker);
      const options = screen.getAllByRole('option');
      const labels = options.map((option) => option.querySelector('.select-option-label')?.textContent ?? '');
      expect(labels).toContain('Beratung');
      expect(labels).toContain('Workshop');
      // The placeholder plus one option per item, and nothing invented.
      expect(options).toHaveLength(ITEMS.length + 1);
      // CHANGED 2026-07-30: the placeholder read "Keine Kategorie" in BOTH item pickers, the wrong noun
      // twice, because `t('item.categoryNone')` was reused on an ITEM select and no `item.itemNone` key
      // existed to reach for.
      expect(labels[0]).toBe('Kein Artikel');
      expect(labels).not.toContain('Keine Kategorie');
      // Close the portaled listbox before opening the next section's picker.
      await userEvent.keyboard('{Escape}');
    }
  });

  it('is honestly disabled until an item is chosen, rather than a button that resolves nothing', async () => {
    const resolveSpy = vi.fn<CannedHandler>(() => ok({ priceMinor: 100, currency: 'CHF', source: 'base' }));
    const { container } = await openPriceLists({ ...HAPPY, price_resolve: resolveSpy });
    await screen.findByRole('heading', { name: 'Preis ermitteln' });
    const resolve = panel(container, 'resolve');
    const button = within(resolve).getByRole('button', { name: 'Preis ermitteln' });

    expect(button).toBeDisabled();
    expect(within(resolve).getByText('Wähle den Artikel, dessen Preis du ermitteln willst.')).toBeInTheDocument();

    await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
  });

  it('labels EVERY source the engine can return, so no tier renders a raw dot-path (D17)', async () => {
    // The badge key is assembled from a value the ENGINE chose, which is what D17 governs, and the
    // component reads it with `tStrict` so an unknown tier is a loud dev failure rather than a
    // `pricelists.source.x` dot-path on a price. The claim held here is the other half, and the one a
    // test can make without fighting React's error path: every source `resolvePrice` actually returns
    // has copy. The three are the whole precedence in `src/core/sales/priceLists.ts`.
    const LABELS: Record<string, string> = {
      contact: 'Kundenpreis',
      segment: 'Segmentpreis',
      base: 'Basispreis',
    };
    for (const [source, label] of Object.entries(LABELS)) {
      const { container, unmount } = await openPriceLists({
        ...HAPPY,
        price_resolve: ok({ priceMinor: 13500, currency: 'CHF', source }),
      });
      const resolve = panel(container, 'resolve');
      await userEvent.click(within(resolve).getByRole('combobox', { name: 'Artikel' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beratung' }));
      await userEvent.click(within(resolve).getByRole('button', { name: 'Preis ermitteln' }));

      expect(await within(resolve).findByText(label), source).toBeInTheDocument();
      // A dot-path reaching the screen is the failure this guards, so it is asserted as such.
      expect(within(resolve).queryByText(`pricelists.source.${source}`)).not.toBeInTheDocument();
      unmount();
    }
  });
});

// --- removing a price, and removing a whole list (F6) ----------------------------------------------

describe('Preislisten, the two removals', () => {
  const ONE_PRICE = ok({
    prices: [{ id: 'p1', itemId: 'i1', priceMinor: 13500, currency: 'CHF', validFrom: '2026-01-01' }],
  });

  it('removes an item price behind a confirm, and re-reads the rows', async () => {
    const unsetSpy = vi.fn<CannedHandler>(() => ok({ removed: 1 }));
    let getCalls = 0;
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_unset_price: unsetSpy,
      price_lists_get: () => {
        getCalls += 1;
        return getCalls === 1 ? ONE_PRICE : ok({ prices: [] });
      },
    });
    await selectList('Meier AG');
    const prices = panel(container, 'prices');

    await userEvent.click(within(prices).getByRole('button', { name: 'Aktionen für den Preis von Beratung' }));
    await userEvent.click(within(prices).getByRole('menuitem', { name: 'Preis entfernen' }));
    expect(unsetSpy, 'the menu press alone must not remove anything').not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Beratung/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preis entfernen' }));

    await waitFor(() => expect(unsetSpy).toHaveBeenCalledOnce());
    const sent = unsetSpy.mock.calls[0][0];
    // The ITEM, with no validFrom: "take this item off the list" is what makes price_resolve fall
    // through to the next scope. The dated arm is the engine's, for a price-history editor.
    expect(sent).toMatchObject({ workspaceId: 'ws_test', priceListId: 'pl_meier', itemId: 'i1' });
    expect(sent.validFrom).toBeUndefined();
    expect(typeof sent.idempotencyKey).toBe('string');
    await waitFor(() => expect(within(prices).getByText('In dieser Liste ist noch kein Preis festgelegt.')).toBeInTheDocument());
  });

  it('marks both removals as danger, and cancelling either one writes nothing', async () => {
    const unsetSpy = vi.fn<CannedHandler>(() => ok({ removed: 1 }));
    const deleteSpy = vi.fn<CannedHandler>(() => ok({ deleted: true }));
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_get: ONE_PRICE,
      price_lists_unset_price: unsetSpy,
      price_lists_delete: deleteSpy,
    });
    await selectList('Meier AG');

    const row = (await screen.findByRole('button', { name: 'Meier AG' })).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Aktionen für Preisliste Meier AG' }));
    expect(within(row).getByRole('menuitem', { name: 'Preisliste löschen' })).toHaveClass('btn--danger');
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Preisliste löschen' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Abbrechen' }));
    expect(deleteSpy).not.toHaveBeenCalled();

    const prices = panel(container, 'prices');
    await userEvent.click(within(prices).getByRole('button', { name: 'Aktionen für den Preis von Beratung' }));
    expect(within(prices).getByRole('menuitem', { name: 'Preis entfernen' })).toHaveClass('btn--danger');
  });

  it('deletes a whole list, says its rows go with it, and drops the selection', async () => {
    const deleteSpy = vi.fn<CannedHandler>(() => ok({ deleted: true, removedPrices: 1 }));
    let listCalls = 0;
    await openPriceLists({
      ...HAPPY,
      price_lists_get: ONE_PRICE,
      price_lists_delete: deleteSpy,
      price_lists_list: () => {
        listCalls += 1;
        return ok({ priceLists: listCalls === 1 ? LISTS : LISTS.filter((l) => l.id !== 'pl_meier') });
      },
    });
    await selectList('Meier AG');

    const row = (await screen.findByRole('button', { name: 'Meier AG' })).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Aktionen für Preisliste Meier AG' }));
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Preisliste löschen' }));

    const dialog = await screen.findByRole('alertdialog');
    // The cascade is STATED, and so is what survives it: an issued document keeps its snapshotted price.
    expect(within(dialog).getByText(/samt allen Preisen/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Bestehende Belege behalten den Preis/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preisliste löschen' }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledOnce());
    expect(deleteSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', priceListId: 'pl_meier' });
    expect(typeof deleteSpy.mock.calls[0][0].idempotencyKey).toBe('string');
    // The price editor is gone with the list: left pointed at a deleted id it would read `not_found`.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Preise' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Meier AG' })).not.toBeInTheDocument();
  });

  it('reports a refused list delete by NAME and keeps the list on screen', async () => {
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_delete: reject('price_list_referenced', 422, { refs: ['custom_field_value'] }),
    });
    await screen.findByRole('button', { name: 'Meier AG' });

    const row = (screen.getByRole('button', { name: 'Meier AG' })).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Aktionen für Preisliste Meier AG' }));
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Preisliste löschen' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Preisliste löschen' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Diese Preisliste wird noch verwendet/)).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Diesen Fehler melden' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meier AG' })).toBeInTheDocument();
    expect(container.querySelector('.pricelists')).not.toBeNull();
  });

  it('names the existing list in a scope_taken refusal, which is why the engine sends its id', async () => {
    // The remediation that added `scope_taken` returns the EXISTING `priceListId` precisely so the
    // caller can point at it, and the surface said nothing about which list to edit instead.
    const { container } = await openPriceLists({
      ...HAPPY,
      price_lists_upsert: reject('scope_taken', 422, { priceListId: 'pl_wv', segment: 'Wiederverkäufer' }),
    });
    await screen.findByRole('heading', { name: 'Preisliste anlegen' });
    const create = panel(container, 'create');

    await userEvent.type(within(create).getByLabelText('Bezeichnung'), 'Zweite');
    await userEvent.type(within(create).getByLabelText('Segment'), 'Wiederverkäufer');
    await userEvent.click(within(create).getByRole('button', { name: 'Preisliste anlegen' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/schon die Preisliste Wiederverkauf/)).toBeInTheDocument();
  });
});
