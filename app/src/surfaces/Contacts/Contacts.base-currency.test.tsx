/**
 * Contacts in a workspace whose books are NOT kept in francs.
 *
 * THE DEFECT THIS EXISTS FOR. `ContactEditor` initialised its picker with
 * `useState(contact?.defaultCurrency ?? 'CHF')` and sends `defaultCurrency` on EVERY write. In
 * create mode that made the client send an explicit 'CHF', which legitimately beat the engine's own
 * default: `createContact` resolves an unnamed currency to `baseCurrencyOf(ctx)`, and a caller that
 * names one is obeyed. So a EUR-book operator who never touched the picker got francs, and the
 * engine-side sweep was invisible to every GUI user until this closed.
 *
 * It is not a cosmetic default. `contact.default_currency` is a SEED: the documents raised against
 * that party inherit it, so a franc stamped into a EUR book here is wrong once now and wrong again
 * on every invoice afterwards.
 *
 * The shape of the fix is the one the Studio already uses in two places: the surface reads
 * `get_company_profile` alongside its own list, and the editor seeds a NEW record from it while an
 * EXISTING record keeps the currency it was saved with. Re-denominating a party that already has a
 * currency would silently change what its next invoice is billed in.
 *
 * NO MIGRATION, and one would be actively wrong. `defaultCurrency` takes caller input, so a stored
 * 'CHF' is genuinely ambiguous between "the caller chose francs" and "the caller said nothing", and
 * nothing on the row records which. A blanket update would be a transform over a guess.
 *
 * The suite runs the surface's five canonical states (loading, empty, error, success,
 * permission-denied) against a EUR profile, because the states are also the entry points: the empty
 * state carries its own "New contact" trigger, and an empty book is precisely a new workspace, the
 * likeliest moment for the first contact to be created in the wrong unit. The final block is the
 * drift guard: the fixtures below are read against the ENGINE SOURCE so a fixture that quietly stops
 * matching what the engine answers fails here rather than passing forever.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { CURRENCIES } from './model';
import Contacts from './index';

/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422): RestResponse => ({
  status,
  body: { ok: false, error },
});

/**
 * A EUR-base workspace, in the shape `get_company_profile` really answers: the wrapper first, the
 * profile one level down. Reading `body.baseCurrency` instead of `body.profile.baseCurrency` is the
 * assumed-shape bug family, so the fixture nests it and the drift guard below pins the nesting.
 */
const EUR_PROFILE = ok({
  profile: { workspaceId: 'ws_test', name: 'Nomadik GmbH', baseCurrency: 'EUR' },
});

/** A contact carrying its own currency, deliberately neither the base nor CHF. */
const USD_CONTACT = {
  id: 'k1',
  partyRole: 'customer',
  name: 'Export AG',
  defaultCurrency: 'USD',
};

/** A contact the engine answered with no currency at all: the branch that must not land on CHF. */
const NO_CURRENCY_CONTACT = {
  id: 'k2',
  partyRole: 'customer',
  name: 'Namensfirma',
  defaultCurrency: null,
};

function renderContacts(canned: Canned, transportWrap: (t: Transport) => Transport = (t) => t) {
  const inner: Transport = async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return render(
    <TillClientProvider client={new TillClient(transportWrap(inner))}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Contacts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const base = (contacts: unknown[], extra: Canned = {}): Canned => ({
  list_contacts: ok({ contacts }),
  get_company_profile: EUR_PROFILE,
  ...extra,
});

describe('Contacts, the base currency is a setting and not a synonym for CHF', () => {
  it('LOADING: asks the engine for the base currency, it does not assume one', async () => {
    // The claim is about the READ, not the skeleton: every surface here starts with `loading` true,
    // so the skeleton is on screen before any effect fires and asserting it alone would hold over a
    // surface that asks for nothing. Waiting on both actions by NAME is what makes this a statement
    // that the profile is genuinely fetched rather than guessed.
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Contacts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('get_company_profile');
    await transport.started('list_contacts');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('EMPTY: the first contact of an empty book is created in the base currency, not CHF', async () => {
    // An empty book is a NEW workspace, which is exactly when the base currency was just chosen and
    // the first contact is about to be created. The empty state carries its own trigger, a second
    // entry point into the editor, so it is asserted rather than assumed to behave like the header.
    renderContacts(base([]));
    expect(await screen.findByText('No contacts yet')).toBeInTheDocument();
    const triggers = screen.getAllByRole('button', { name: 'New contact' });
    expect(triggers).toHaveLength(2);
    await userEvent.click(triggers[1]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Default currency')).toHaveValue('EUR');
  });

  it('ERROR: a failed profile read falls back to CHF, and does not take the list down with it', async () => {
    // The fallback is a fallback. A surface that cannot name its currency is worse than one naming
    // the common one, the engine still owns what a write records, and the contacts are this
    // surface's actual job: a profile that will not load must not blank them.
    renderContacts(
      base([USD_CONTACT], { get_company_profile: { status: 500, body: { ok: false, error: 'internal' } } }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'New contact' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Default currency')).toHaveValue('CHF');
    expect(screen.getByText('Export AG')).toBeInTheDocument();
  });

  it('SUCCESS/create: preselects the base currency AND sends it to create_contact', async () => {
    // Both halves matter and only the second one is the bug. A picker showing EUR while the form
    // posts CHF would be worse than the original defect, because the operator would have watched it
    // say EUR. The spy is what makes this a claim about the WRITE.
    const createSpy = vi.fn<CannedHandler>(() => ok({ contactId: 'new1' }));
    renderContacts(base([USD_CONTACT], { create_contact: createSpy }));
    await userEvent.click(await screen.findByRole('button', { name: 'New contact' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Default currency')).toHaveValue('EUR');

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neue AG');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ name: 'Neue AG', defaultCurrency: 'EUR' });
  });

  it('SUCCESS/edit: keeps a contact on its OWN currency, which is not the workspace default', async () => {
    // Editing must never quietly re-denominate an existing party: the row's own currency wins over
    // the workspace setting, and only USD, EUR and CHF all differing makes that visible.
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts(base([USD_CONTACT], { update_contact: updateSpy }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Default currency')).toHaveValue('USD');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ patch: { defaultCurrency: 'USD' } });
  });

  it('SUCCESS/edit: a contact with NO currency of its own falls to the base, not to CHF', async () => {
    // `defaultCurrency` is nullable on the read model, so "no currency" and "create" are the same
    // question and get the same answer. CHF is a unit these books have never held.
    renderContacts(base([NO_CURRENCY_CONTACT]));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Default currency')).toHaveValue('EUR');
  });

  it('PERMISSION-DENIED: offers no editor at all, so no currency is preselected anywhere', async () => {
    renderContacts(base([], { list_contacts: reject('permission_denied', 403) }));
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New contact' })).toBeNull();
  });

  it('offers only currencies the engine accepts, so no pick is a guaranteed rejection', async () => {
    // GBP used to sit in this list. `createContact` rejects it with `invalid_currency`, so choosing
    // it and pressing Save could only ever produce an error banner: a dead end the form offered.
    renderContacts(base([USD_CONTACT]));
    await userEvent.click(await screen.findByRole('button', { name: 'New contact' }));
    const dialog = await screen.findByRole('dialog');
    const options = within(dialog)
      .getByLabelText('Default currency')
      .querySelectorAll('option');
    expect([...options].map((o) => o.textContent)).toEqual(['CHF', 'EUR', 'USD']);
  });
});

/**
 * The drift guard: the fixtures above, checked against the engine source.
 *
 * A fixture is a claim about what the engine answers, and a claim nothing checks rots silently. The
 * failure mode this repo keeps hitting is a jsdom suite staying green against a wire shape the
 * engine stopped sending, so each assertion below reads `src/` OFF DISK as text and fails when the
 * engine and this file stop agreeing.
 *
 * Reading rather than importing is the established form here (`Periods/audit-vocabulary.test.ts`):
 * the browser bundle must never touch engine code, because `better-sqlite3` is native and Node-only,
 * but a Node-side test may read the files as text.
 */
describe('the fixtures still match the engine', () => {
  const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '../../../../src');
  const read = (rel: string): string => readFileSync(join(ENGINE, rel), 'utf8');

  it('offers exactly the currencies the engine enum admits', () => {
    // The list the editor renders is a fork of an engine enum the moment the enum changes. Parsed
    // out of the source rather than retyped, so adding a fourth currency engine-side fails here
    // instead of quietly leaving the picker one short.
    const enums = read('core/setup/enums.ts');
    const match = /export const CURRENCIES = new Set\(\[([^\]]*)\]\)/.exec(enums);
    expect(match, 'CURRENCIES has moved or changed shape in src/core/setup/enums.ts').not.toBeNull();
    const engineCodes = [...(match as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(engineCodes.length).toBeGreaterThan(0);
    expect([...CURRENCIES].sort()).toEqual([...engineCodes].sort());
  });

  it('reads baseCurrency where get_company_profile actually puts it', () => {
    // EUR_PROFILE nests the code under `profile`. If the verb ever answered it at the top level the
    // fixture would still be accepted by the surface's optional chain, and every assertion above
    // would go on passing over a value the engine no longer sends there.
    const profile = read('core/setup/companyProfile.ts');
    expect(profile).toMatch(/return ok\(\{\s*profile: \{/);
    expect(profile).toMatch(/baseCurrency: row\.base_currency/);
  });

  it('still lets an unnamed currency fall to the workspace base, which is what the GUI now agrees with', () => {
    // The whole point of sending the base rather than a literal is that the GUI and the engine reach
    // the same answer. If `createContact` ever went back to writing a literal, the surface would be
    // agreeing with something that no longer exists and this fails rather than the books drifting.
    expect(read('core/sales/contact.ts')).toMatch(/input\.defaultCurrency \?\? baseCurrencyOf\(ctx\)/);
  });
});
