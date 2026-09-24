import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads, type WatchedTransport } from '../../test-transport';
import { recordedOk } from '../../lib/test-support';
import { CompanyProfile } from './CompanyProfile';

/** The engine's real `list_workspaces` shape; the root suite pins it against a live engine call. */
import workspacesFixture from './workspaces.fixture.json';

const WORKSPACES: RestResponse = { status: 200, body: recordedOk(workspacesFixture) };

/** A route is either a fixed response or a function of the input. */
type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);

function makeTransport(routes: Record<string, Route>): WatchedTransport {
  const base: Transport = async (action, input) => {
    // The Arbeitsbereiche panel (D24) lists workspaces on BOTH faces of the surface, so the list
    // read gets a default; a test overrides it to exercise the panel's own states.
    const route = routes[action] ?? (action === 'list_workspaces' ? WORKSPACES : undefined);
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  // Watched so a loading test can prove the read it asserts over actually started.
  return watchReads(base);
}

function makeClient(routes: Record<string, Route>): TillClient {
  return new TillClient(makeTransport(routes));
}

function renderSurface(client: TillClient, initialId: string | null, path = '/setup') {
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={initialId}>
          {/* The panel's rows navigate, so the surface needs a router context in tests too. */}
          <MemoryRouter initialEntries={[path]}>
            <CompanyProfile />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/**
 * The engine's REAL `get_company_profile` shape, read from a SHARED fixture file rather than
 * hand-written here.
 *
 * The previous hand-written fixture was flat (`body.name`) while the engine answers
 * `{ok: true, profile: {...}}`, and the surface read the wrapper as if it were the profile. The two
 * mistakes cancelled out in the test and nowhere else, so every field fell back to its default and
 * the real form rendered blank against a workspace that had data. A green app test could not catch
 * that, because nothing compared it to the engine.
 *
 * So the fixture now lives in `company-profile.fixture.json`, and the ROOT suite
 * (`test/setup/profile-fixture.test.mjs`) asserts its key set against a live `getCompanyProfile`
 * call. Rename or add an engine field without updating the fixture and the root suite fails by
 * name. Do not inline a profile shape back into this file: that re-opens the hole.
 */
import fixture from './company-profile.fixture.json';

const FULL_PROFILE: RestResponse = { status: 200, body: recordedOk(fixture) };

/**
 * The `set_creditor_profile` rejection codes, read from the SHARED contract the surface itself maps
 * from. The root suite (`test/setup/creditor-error-contract.test.mjs`) pins this file to the live
 * engine in both directions, so a code asserted here is a code the engine really emits.
 *
 * That indirection is the whole point. This test used to mock `not_a_qr_iban` and assert the
 * matching message: an engine code that no longer exists, pinned by the client against itself. It
 * stayed green while a user typing a perfectly ordinary IBAN got a message about needing a QR-IBAN.
 * A mock can only restate an assumption, so the assumption has to be pinned somewhere else.
 */
import contract from './creditor-error-contract.json';

/** An ORDINARY Swiss IBAN (QR-IID 00762, outside the reserved QR range): the SCOR path. */
const PLAIN_IBAN = 'CH9300762011623852957';

/**
 * The ONE first-hour panel (F-09): since 2026-09-06 the creditor IBAN, the legal form and the MWST
 * capture share the "Firmenangaben" panel and its single save. The old three-panel helpers resolved
 * to regions that no longer exist; every save now goes through this panel's one "Speichern".
 */
async function creditorPanel(): Promise<HTMLElement> {
  return (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
}

/** Open the QR-bill address disclosure on the loaded panel (closed by default while no address is stored). */
async function openAddress(panel: HTMLElement): Promise<void> {
  const toggle = within(panel).getByRole('button', { name: 'Rechnungssteller (QR-Rechnung)' });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
}

/** Open the "Weitere Angaben" disclosure (UID, MWST-Nr, currency, fiscal year). */
async function openMore(panel: HTMLElement): Promise<void> {
  const toggle = within(panel).getByRole('button', { name: 'Weitere Angaben' });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
}

/** The writes the one save issues on the FULL fixture, all answering ok, for tests about one field. */
const SAVE_OK: Record<string, Route> = {
  update_company_profile: { status: 200, body: { ok: true } },
  set_fiscal_config: { status: 200, body: { ok: true } },
  set_creditor_profile: { status: 200, body: { ok: true } },
  vat_configure: { status: 200, body: { ok: true } },
  vat_seed_defaults: { status: 200, body: { ok: true } },
};

/**
 * The Arbeitsbereiche panel with its OWN read answered, rather than the first frame of it.
 *
 * This surface issues two reads, not one. `get_company_profile` fills the form, and mounting the
 * loaded face mounts `WorkspacesPanel`, which then issues `list_workspaces` of its own. The panel
 * renders its `<section>` immediately, under a skeleton, so `findByRole('region')` resolves WHILE
 * THAT SECOND READ IS STILL OUT and hands back a surface that is still moving.
 *
 * Proof that the old anchor claimed nothing: with `list_workspaces` hung forever, all three axe
 * tests below still passed. They were auditing whatever the scheduler happened to have delivered.
 *
 * That mattered most in the axe tests, for the same two reasons it did in
 * `Documents/DocumentDetail.fx.test.tsx`. An accessibility pass over a half-loaded panel audits
 * three skeleton bars instead of the list a person reads. And holding the tree mounted for the
 * length of that pass is a window of hundreds of milliseconds, not a few microtasks, for the
 * pending update to land in: Testing Library turns React's act environment off for the duration of
 * a `findBy` and back on one `setTimeout(0)` later, so whether that update counts as "inside the
 * test" is decided by which task runs first. Losing that toss is a `console.error` that the guard
 * in `src/test-console.ts` fails the test on, which is what a saturated full-suite run produced.
 *
 * The rows are a state the panel CANNOT be in until `list_workspaces` answered, so waiting for them
 * is a statement about that read and not a sleep, and it leaves nothing in flight behind it.
 */
async function settledWorkspacesPanel(): Promise<HTMLElement> {
  const panel = (await screen.findByRole('region', { name: 'Arbeitsbereiche' })) as HTMLElement;
  await within(panel).findAllByRole('listitem');
  return panel;
}

/**
 * The loaded profile BODY, rather than the heading that is painted before the read is asked.
 *
 * `<h1>Firmenprofil</h1>` is not a load signal and never was. `CompanyProfile.tsx` renders the
 * section and its h1 UNCONDITIONALLY, and swaps only the panel beneath them when
 * `get_company_profile` answers; the component says so in as many words ("Loading and ready share
 * one persistent section + heading, so the h1 node never detaches on the load -> ready swap"). The
 * anchor was chosen to be stable across that swap, which is exactly what makes it useless for
 * waiting on it.
 *
 * Proof that the old anchor claimed nothing, measured rather than reasoned: with
 * `get_company_profile` hung forever, `findByRole('heading', {name: 'Firmenprofil'})` still
 * resolves, `role="status"` is still `aria-busy="true"`, and `queryByLabelText('Firmenname')` is
 * null. Every test that anchored there and then reached for a form control was racing the canned
 * response: green because the mock resolved in the same microtask, red the moment a saturated
 * machine let the assertion run first. Under a six-way concurrent campaign that is what two of them
 * did, with `Unable to find a label with the text of: Firmenname` against a tree of skeleton bars.
 *
 * The vacuous case is worse than the flaky one. The VAT-badge test asserts that
 * `/MWST-Methode/` is ABSENT, and a skeleton satisfies that for the wrong reason, so the test could
 * pass while the null handling it exists to prove was broken.
 *
 * `Firmenangaben` is rendered by `ProfileBody` and by nothing else, so it is a state the surface
 * CANNOT be in until the profile read answered: waiting for it is a statement about that read and
 * not a sleep.
 */
async function loadedProfileBody(): Promise<HTMLElement> {
  return (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
}

/** The same engine shape with the §H-FX lock engaged, as a workspace with a posted entry reports. */
const LOCKED_PROFILE: RestResponse = {
  status: 200,
  body: recordedOk({ ...fixture, profile: { ...fixture.profile, ledgerLocked: true } }),
};

describe('CompanyProfile: five states', () => {
  it('renders the loading skeleton while get_company_profile is pending', async () => {
    // A route that never resolves keeps the surface in its loading state.
    const transport = makeTransport({ get_company_profile: () => new Promise<RestResponse>(() => {}) });
    renderSurface(new TillClient(transport), 'ws_test');
    // The surface paints its skeleton on the first commit, so `findByRole('status')` on its own
    // says nothing about the profile read: it would resolve just as fast against a surface that
    // never asked for one. The wait is what pins the skeleton to a read genuinely in flight.
    await transport.started('get_company_profile');
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    // The loading face is the skeleton and nothing else: the Arbeitsbereiche panel, which has its
    // own read, is not mounted until the profile has arrived. So there is no second read left in
    // flight here, and nothing can land after teardown.
    expect(transport.asked).toEqual(['get_company_profile']);
  });

  it('renders the empty create state when there is no workspace', async () => {
    const client = makeClient({});
    renderSurface(client, null);
    // Heading and the create call to action both come from i18n, not hardcoded copy.
    expect(screen.getByRole('heading', { level: 1, name: 'Arbeitsbereich einrichten' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' })).toBeInTheDocument();
    // The Arbeitsbereiche panel arrives async on this face; awaiting it keeps the update in act.
    expect(await screen.findByRole('region', { name: 'Arbeitsbereiche' })).toBeInTheDocument();
  });

  it('renders an error banner with a retry for a real engine Err code', async () => {
    const client = makeClient({
      get_company_profile: { status: 404, body: { ok: false, error: 'workspace_not_found' } },
    });
    renderSurface(client, 'ws_test');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Der gewählte Arbeitsbereich wurde nicht gefunden.');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('renders the success profile form with the loaded data', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    renderSurface(client, 'ws_test');
    // The body, not the h1: the heading is painted before the read is even asked (`loadedProfileBody`).
    const panel = await loadedProfileBody();
    expect(screen.getByRole('heading', { level: 1, name: 'Firmenprofil' })).toBeInTheDocument();
    expect(screen.getByLabelText('Firmenname')).toHaveValue('Muster Grafik');
    expect(screen.getByLabelText('IBAN für deine Rechnungen')).toHaveValue('CH44 3199 9123 0008 8901 2');
    // F-09: the read-once facts sit behind "Weitere Angaben"; the stored address opens its own disclosure.
    expect(screen.getByLabelText('Strasse')).toHaveValue('Bahnhofstrasse');
    await openMore(panel);
    expect(screen.getByLabelText('UID')).toHaveValue('CHE-123.456.789');
    // The MWST method + timing are shown read-only as badges reflecting the stored values.
    expect(screen.getByText('MWST-Methode: Effektiv')).toBeInTheDocument();
    expect(screen.getByText('MWST-Abrechnungsart: Vereinbart (Soll)')).toBeInTheDocument();
  });

  it('renders the permission-denied panel when the read is forbidden', async () => {
    const client = makeClient({
      get_company_profile: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    renderSurface(client, 'ws_test');
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });
});

describe('CompanyProfile: the accent budget', () => {
  // The accent marks exactly one primary action per SURFACE, so a solid `.btn--primary` fill can
  // only appear once in a render. The file holds two, and the audit read that as a violation: it is
  // not, because the two sit on mutually exclusive branches (no workspace returns the create form
  // and nothing else). These two tests hold that apart, so a later edit cannot merge the branches
  // and quietly put two solid accents on one screen.
  it('paints exactly one solid primary on the no-workspace branch', async () => {
    const { container } = renderSurface(makeClient({}), null);
    // The empty state discloses the form; the primary lives on the form, not on the invitation.
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));
    const primaries = container.querySelectorAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent('Arbeitsbereich erstellen');
  });

  it('paints exactly one solid primary on the loaded-profile branch', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    const { container } = renderSurface(client, 'ws_test');
    // A budget is a claim about the WHOLE surface, so it has to be counted over the whole surface.
    // The heading alone lands while `list_workspaces` is still out, and the count would then be
    // taken over a tree with the Arbeitsbereiche panel showing three skeleton bars. Today that panel
    // contributes no primary, so the number happens to be right either way: the anchor is what stops
    // that from being luck the day the panel grows a button.
    await settledWorkspacesPanel();
    const primaries = container.querySelectorAll('.btn--primary');
    expect(primaries).toHaveLength(1);
    // The three panel saves are co-equal writes; only the company panel carries the accent, and the
    // create-workspace action is not on this branch at all.
    expect(primaries[0]).toHaveTextContent('Speichern');
  });
});

describe('CompanyProfile: accessibility', () => {
  it('the success render has no axe violations', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    const { container } = renderSurface(client, 'ws_test');
    await screen.findByRole('heading', { level: 1, name: 'Firmenprofil' });
    // Settled, not merely mounted: see `settledWorkspacesPanel`. Both of this surface's reads have
    // answered here, so the pass audits the finished screen and nothing can update into it.
    await settledWorkspacesPanel();
    // Page-level best-practice rules do not apply to a mounted fragment: the shell supplies the
    // landmark and single h1. Content a11y rules stay on.
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('the IBAN help control carries an aria-label', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    renderSurface(client, 'ws_test');
    // The help control lives in the creditor panel, which only exists once the read answered.
    await loadedProfileBody();
    expect(screen.getByRole('button', { name: 'Welche IBAN brauche ich?' })).toBeInTheDocument();
  });
});

describe('CompanyProfile: create workspace', () => {
  it('creates a workspace and transitions to the profile', async () => {
    const client = makeClient({
      create_workspace: { status: 200, body: { ok: true, workspaceId: 'ws_new' } },
      get_company_profile: FULL_PROFILE,
    });
    renderSurface(client, null);

    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));
    await userEvent.type(screen.getByLabelText('Firmenname'), 'Neue Firma');
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));

    // Selecting the new workspace flips the surface to the loaded profile face. The h1 flips as soon
    // as the id is set, so waiting on it would claim the transition while the profile read was still
    // out and leave it in flight at teardown; the body is the state that needs the answer.
    await loadedProfileBody();
    expect(screen.getByRole('heading', { level: 1, name: 'Firmenprofil' })).toBeInTheDocument();
  });

  it('F-09 (J1.5): the first books offer the legal form, defaulted from the name, and mint through create_workspace', async () => {
    const create = vi.fn(() => ({ status: 200, body: { ok: true, workspaceId: 'ws_new' } }) as RestResponse);
    const client = makeClient({ create_workspace: create, get_company_profile: FULL_PROFILE });
    renderSurface(client, null);
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));
    await userEvent.type(screen.getByLabelText('Firmenname'), 'Bergblick AG');
    // The suffix decides the default; the select stays on the form for the case it is wrong.
    expect(screen.getByLabelText('Rechtsform')).toHaveTextContent('Aktiengesellschaft (AG)');
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));
    await loadedProfileBody();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bergblick AG', legalForm: 'ag' }));
  });

  it('F-09 (J1.5): /setup?new=1 is the new-mandate face: the create form, no profile of the current mandate, seated via onboard_client', async () => {
    const onboard = vi.fn(() => ({ status: 200, body: { ok: true, workspaceId: 'ws_mandate' } }) as RestResponse);
    const profileRead = vi.fn((_input: Record<string, unknown>) => FULL_PROFILE);
    const client = makeClient({ onboard_client: onboard, get_company_profile: profileRead });
    renderSurface(client, 'ws_test', '/setup?new=1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Neuer Arbeitsbereich' })).toBeInTheDocument();
    // The current mandate's profile is NOT on this page: nothing typed here can edit it.
    expect(screen.queryByRole('region', { name: 'Firmenangaben' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Muster Grafik')).not.toBeInTheDocument();
    expect(profileRead).not.toHaveBeenCalled();

    const name = screen.getByLabelText('Firmenname');
    expect(name).toHaveFocus();
    await userEvent.type(name, 'Alpenrose Treuhand-Mandat AG');
    await userEvent.click(screen.getByLabelText('Rechtsform'));
    await userEvent.click(screen.getByRole('option', { name: 'Aktiengesellschaft (AG)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));

    // A23 US-A23.2: a mandate beside existing books is onboard_client (workspace + chart + the caller
    // seated as accepted owner), never a bare create_workspace.
    await waitFor(() => expect(onboard).toHaveBeenCalledOnce());
    expect(onboard).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alpenrose Treuhand-Mandat AG', legalForm: 'ag', baseCurrency: 'CHF', fiscalYearStart: '01-01' }));
    // The new books are adopted and opened: the profile loader now reads THE NEW workspace.
    await waitFor(() => expect(profileRead).toHaveBeenCalled());
    expect(profileRead.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ workspaceId: 'ws_mandate' }));
  });

  it('shows an inline invalid_name error and writes nothing', async () => {
    const create = vi.fn(() => ({ status: 422, body: { ok: false, error: 'invalid_name' } }) as RestResponse);
    const client = makeClient({ create_workspace: create });
    renderSurface(client, null);

    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich erstellen' }));

    expect(await screen.findByText('Bitte einen Firmennamen eingeben.')).toBeInTheDocument();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('CompanyProfile: saves', () => {
  it('saves the company details and shows the saved status', async () => {
    const update = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: FULL_PROFILE, ...SAVE_OK, update_company_profile: update });
    renderSurface(client, 'ws_test');

    const panel = (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));

    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_test', name: 'Muster Grafik', legalForm: 'gmbh' }));
  });

  it('F-09: ONE save on a fresh workspace writes the four verbs with the Swiss defaults pre-set', async () => {
    // A workspace straight from the create door: name only, no legal form, no MWST method, no IBAN.
    const fresh: RestResponse = {
      status: 200,
      body: recordedOk({
        ...fixture,
        profile: { ...fixture.profile, name: 'Bergblick AG', legalForm: null, vatMethod: null, vatAccounting: null, creditorName: null, creditorAddress: null, creditorIban: null, uid: null, mwstNo: null },
      }),
    };
    const calls: Array<{ verb: string; input: Record<string, unknown> }> = [];
    const record = (verb: string) => (input: Record<string, unknown>) => {
      calls.push({ verb, input });
      return { status: 200, body: { ok: true } } as RestResponse;
    };
    const client = makeClient({
      get_company_profile: fresh,
      update_company_profile: record('update_company_profile'),
      set_fiscal_config: record('set_fiscal_config'),
      vat_configure: record('vat_configure'),
      vat_seed_defaults: record('vat_seed_defaults'),
      set_creditor_profile: record('set_creditor_profile'),
    });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();

    // The legal form is DEFAULTED from the name ("... AG" is an AG), the MWST choice from the Swiss
    // common case; neither is a decision the person has to take (J1.1 ideal: D 3 includes them only
    // when the default is wrong).
    expect(within(panel).getByLabelText('Rechtsform')).toHaveTextContent('Aktiengesellschaft (AG)');
    expect(within(panel).getByLabelText('MWST-Methode')).toHaveTextContent('MWST-pflichtig, effektive Methode');
    expect(within(panel).getByLabelText('MWST-Abrechnungsart')).toHaveTextContent('Vereinbart (Soll)');
    // The address is a deferral the panel says out loud, never a gate.
    expect(within(panel).getByText(/Die Adresse brauchst du erst/)).toBeInTheDocument();

    await userEvent.type(within(panel).getByLabelText('IBAN für deine Rechnungen'), PLAIN_IBAN);
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));
    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();

    const verbs = calls.map((c) => c.verb);
    expect(verbs).toEqual(['update_company_profile', 'vat_configure', 'vat_seed_defaults', 'set_creditor_profile']);
    expect(calls[0]?.input).toEqual(expect.objectContaining({ name: 'Bergblick AG', legalForm: 'ag' }));
    // A blank UID / MWST-Nr is "not given": sending '' would be refused as invalid_uid and take the
    // legal form down with it (measured on the first flow run).
    expect(calls[0]?.input).not.toHaveProperty('uid');
    expect(calls[0]?.input).not.toHaveProperty('mwstNo');
    expect(calls[1]?.input).toEqual(expect.objectContaining({ method: 'effektiv', timing: 'soll', registered: true }));
    // The IBAN alone, with the five address fields blank: the engine treats that as no address.
    expect(calls[3]?.input).toEqual(expect.objectContaining({ iban: PLAIN_IBAN, address: expect.objectContaining({ street: '', town: '' }) }));
    expect(calls[3]?.input).not.toHaveProperty('creditorName');
    // Currency and fiscal year were untouched, so the §H-FX verb is not called at all.
    expect(verbs).not.toContain('set_fiscal_config');
  });

  it('F-09: the QR-bill address is disclosed on demand and saves with the IBAN in the same act', async () => {
    const fresh: RestResponse = {
      status: 200,
      body: recordedOk({ ...fixture, profile: { ...fixture.profile, creditorName: null, creditorAddress: null, creditorIban: null } }),
    };
    const save = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: fresh, ...SAVE_OK, set_creditor_profile: save });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();
    // Closed by default while nothing is stored: the fields are not on the page until asked for.
    expect(within(panel).queryByLabelText('Strasse')).not.toBeInTheDocument();
    await openAddress(panel);
    await userEvent.type(within(panel).getByLabelText('Strasse'), 'Seestrasse');
    await userEvent.type(within(panel).getByLabelText('Haus-Nr.'), '12');
    await userEvent.type(within(panel).getByLabelText('PLZ'), '8002');
    await userEvent.type(within(panel).getByLabelText('Ort'), 'Zürich');
    await userEvent.type(within(panel).getByLabelText('IBAN für deine Rechnungen'), PLAIN_IBAN);
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));
    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        iban: PLAIN_IBAN,
        address: { street: 'Seestrasse', buildingNo: '12', zip: '8002', town: 'Zürich', country: 'CH' },
      }),
    );
  });

  it('F-new-2: an address-first save with a BLANK IBAN omits the iban key, so the engine is not refused invalid_iban', async () => {
    // A fresh workspace with no stored creditor IBAN: the person fills a full structured address (a
    // QR-bill needs the sender address) but has not typed an IBAN yet. The engine SUPPORTS this
    // address-first save: it preserves the (absent) IBAN when the key is omitted. It refuses '' as
    // present-and-invalid (`invalid_iban`), so the surface must OMIT the key when the field is blank,
    // mirroring the creditorName / uid / mwstNo pattern next to it.
    const fresh: RestResponse = {
      status: 200,
      body: recordedOk({ ...fixture, profile: { ...fixture.profile, creditorName: null, creditorAddress: null, creditorIban: null } }),
    };
    const save = vi.fn((_input: Record<string, unknown>) => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: fresh, ...SAVE_OK, set_creditor_profile: save });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();
    await openAddress(panel);
    await userEvent.type(within(panel).getByLabelText('Strasse'), 'Seestrasse');
    await userEvent.type(within(panel).getByLabelText('Haus-Nr.'), '12');
    await userEvent.type(within(panel).getByLabelText('PLZ'), '8002');
    await userEvent.type(within(panel).getByLabelText('Ort'), 'Zürich');
    // IBAN deliberately left blank.
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));

    // The save is NOT refused (a '' iban would be `invalid_iban`), and the payload carries no iban key.
    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    const sent = save.mock.calls[0][0];
    expect(sent).not.toHaveProperty('iban');
    expect(sent).toEqual(
      expect.objectContaining({ address: { street: 'Seestrasse', buildingNo: '12', zip: '8002', town: 'Zürich', country: 'CH' } }),
    );
  });

  it('F-new-2: a valid IBAN is still sent (the IBAN-first path is unchanged)', async () => {
    const save = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: FULL_PROFILE, ...SAVE_OK, set_creditor_profile: save });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();
    const field = within(panel).getByLabelText('IBAN für deine Rechnungen');
    await userEvent.clear(field);
    await userEvent.type(field, PLAIN_IBAN);
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));
    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ iban: PLAIN_IBAN }));
  });

  it('F-09: "Nicht MWST-pflichtig" configures method none and seeds no codes', async () => {
    const fresh: RestResponse = {
      status: 200,
      body: recordedOk({ ...fixture, profile: { ...fixture.profile, vatMethod: null, vatAccounting: null } }),
    };
    const configure = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const seed = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: fresh, ...SAVE_OK, vat_configure: configure, vat_seed_defaults: seed });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();
    await userEvent.click(within(panel).getByLabelText('MWST-Methode'));
    await userEvent.click(screen.getByRole('option', { name: 'Nicht MWST-pflichtig' }));
    expect(within(panel).queryByLabelText('MWST-Abrechnungsart')).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));
    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ method: 'none', registered: false }));
    expect(seed).not.toHaveBeenCalled();
  });

  it('F-09: a stored MWST method is a badge with a way to /vat, never a second capture', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE, ...SAVE_OK });
    renderSurface(client, 'ws_test');
    const panel = await creditorPanel();
    expect(within(panel).queryByRole('combobox', { name: 'MWST-Methode' })).not.toBeInTheDocument();
    expect(within(panel).getByText('MWST-Methode: Effektiv')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Unter MWST ändern' })).toHaveAttribute('href', '/vat');
  });

  it('surfaces invalid_iban, the code the engine really sends, on the creditor panel', async () => {
    const client = makeClient({
      get_company_profile: FULL_PROFILE,
      ...SAVE_OK,
      set_creditor_profile: { status: 422, body: { ok: false, error: 'invalid_iban' } },
    });
    renderSurface(client, 'ws_test');

    const panel = await creditorPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));

    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Das ist keine gültige IBAN');
    // The old copy told the operator to go and get a QR-IBAN. It must not come back: the field takes
    // either kind, and only a malformed number is refused.
    expect(alert).not.toHaveTextContent('Das ist keine QR-IBAN');
  });

  it('saves an ORDINARY (non-QR) IBAN: the kind most Swiss SMEs actually have (M-2)', async () => {
    // The engine used to refuse anything that was not a QR-IBAN, which locked those businesses out
    // of invoicing entirely. It now accepts either kind, and the form must show a plain save, not an
    // error, for the ISO 11649/SCOR path.
    const save = vi.fn(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    const client = makeClient({ get_company_profile: FULL_PROFILE, ...SAVE_OK, set_creditor_profile: save });
    renderSurface(client, 'ws_test');

    const panel = await creditorPanel();
    const field = within(panel).getByLabelText('IBAN für deine Rechnungen');
    await userEvent.clear(field);
    await userEvent.type(field, PLAIN_IBAN);
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));

    expect(await within(panel).findByText('Gespeichert')).toBeInTheDocument();
    expect(within(panel).queryByRole('alert')).toBeNull();
    // Sent as `iban`, the alias `set_creditor_profile` prefers, not the older `qrIban`: the verb has
    // taken any valid IBAN since M-2, and a field named for a constraint that no longer exists is
    // how the column got its wrong name in the first place.
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_test', iban: PLAIN_IBAN }));
  });

  it('gives EVERY code in the engine contract a real message, never the generic fallback', async () => {
    // The defect this file shipped was a mapping for a code the engine no longer sends, mocked here
    // so nothing failed. The mock can only ever restate the client's own assumption, so the codes
    // are read from the SHARED contract that the root suite pins to the live engine. Add a rejection
    // to `setCreditorProfile` and this loop demands a message for it.
    const FALLBACK = 'Die Aktion konnte nicht abgeschlossen werden.';
    for (const code of Object.keys(contract.codes)) {
      const client = makeClient({
        get_company_profile: FULL_PROFILE,
        ...SAVE_OK,
        set_creditor_profile: { status: 422, body: { ok: false, error: code } },
      });
      const view = renderSurface(client, 'ws_test');
      const panel = await creditorPanel();
      await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));
      // A refusal on a field inside a closed disclosure opens it: the message is never hidden.
      const alert = await within(panel).findByRole('alert');

      expect(alert.textContent, `${code} has no message of its own`).not.toContain(FALLBACK);
      expect(alert.textContent, `${code} rendered a raw i18n key`).not.toMatch(/company\./);
      expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('surfaces needs_empty_ledger when the fiscal config is locked by posted entries', async () => {
    const client = makeClient({
      get_company_profile: FULL_PROFILE,
      ...SAVE_OK,
      set_fiscal_config: { status: 422, body: { ok: false, error: 'needs_empty_ledger' } },
    });
    renderSurface(client, 'ws_test');

    const panel = await creditorPanel();
    // The §H-FX verb is only called when currency or fiscal year CHANGED (an unchanged pair would be
    // refused on a locked ledger for no reason), so the test changes the currency first.
    await openMore(panel);
    const currency = within(panel).getByLabelText('Basiswährung');
    await userEvent.clear(currency);
    await userEvent.type(currency, 'EUR');
    await userEvent.click(within(panel).getByRole('button', { name: 'Speichern' }));

    expect(await within(panel).findByText(/lassen sich nicht mehr ändern/)).toBeInTheDocument();
  });
});

describe('CompanyProfile: the fiscal lock (§H-FX, D15/C3)', () => {
  /**
   * The lock used to be dead code: the surface read `profile.ledgerLocked`, the engine never sent
   * it, so `locked` was permanently false and both controls stayed editable on a workspace that
   * had posted entries. The operator only learned at save time. These two tests pin BOTH states,
   * so the control and the engine rule cannot silently drift apart again.
   */
  async function fiscalPanel(profile: RestResponse) {
    const client = makeClient({ get_company_profile: profile });
    renderSurface(client, 'ws_test');
    // F-09: currency and fiscal year are read-once facts behind the "Weitere Angaben" disclosure.
    const panel = await creditorPanel();
    await openMore(panel);
    return panel;
  }

  it('leaves currency and fiscal-year editable while the ledger is empty', async () => {
    const panel = await fiscalPanel(FULL_PROFILE);
    expect(within(panel).getByLabelText('Basiswährung')).toBeEnabled();
    expect(within(panel).getByLabelText('Geschäftsjahresbeginn')).toBeEnabled();
    // No precondition note when there is no precondition to explain.
    expect(within(panel).queryByText(/wurde bereits gebucht/)).not.toBeInTheDocument();
  });

  it('disables both controls once a posted entry exists', async () => {
    const panel = await fiscalPanel(LOCKED_PROFILE);
    expect(within(panel).getByLabelText('Basiswährung')).toBeDisabled();
    expect(within(panel).getByLabelText('Geschäftsjahresbeginn')).toBeDisabled();
    // The legal form is not currency- or period-bearing, so the engine keeps it editable and so
    // must the form: locking the whole panel would over-reach the rule.
    expect(within(panel).getByLabelText('Rechtsform')).toBeEnabled();
  });

  it('explains the precondition INLINE, naming the exact missing condition (D15/C3)', async () => {
    const panel = await fiscalPanel(LOCKED_PROFILE);
    const note = within(panel).getByText(/wurde bereits gebucht/);
    expect(note).toBeInTheDocument();
    // Not tooltip-only: the note is in the document unprompted, with no hover or focus.
    expect(note).toBeVisible();
  });

  it('ties the note to BOTH disabled controls with aria-describedby, so it is never mouse-only', async () => {
    const panel = await fiscalPanel(LOCKED_PROFILE);
    const note = within(panel).getByText(/wurde bereits gebucht/);
    const noteId = note.getAttribute('id');
    expect(noteId).toBeTruthy();
    expect(within(panel).getByLabelText('Basiswährung')).toHaveAttribute('aria-describedby', noteId);
    expect(within(panel).getByLabelText('Geschäftsjahresbeginn')).toHaveAttribute('aria-describedby', noteId);
  });

  it('has no axe violations in the locked state', async () => {
    const client = makeClient({ get_company_profile: LOCKED_PROFILE });
    const { container } = renderSurface(client, 'ws_test');
    await screen.findByRole('heading', { level: 1, name: 'Firmenprofil' });
    // Settled, for the same two reasons as the sibling axe tests.
    await settledWorkspacesPanel();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('CompanyProfile: the VAT badges on an unconfigured workspace', () => {
  /*
   * A workspace whose VAT is not configured yet stores these columns as SQLite NULL, and the engine
   * passes that through as `null`. The surface guarded only `undefined`, so it built the key
   * `company.vatMethod.null` and rendered a missing translation on the first screen a new user sees.
   * Every fixture had VAT configured, which is why 215 green tests never noticed.
   */
  const UNCONFIGURED: RestResponse = {
    status: 200,
    body: recordedOk({ ...fixture, profile: { ...fixture.profile, vatMethod: null, vatAccounting: null } }),
  };

  it('offers the MWST capture (never a badge, never a raw i18n key) when the method is null', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient({ get_company_profile: UNCONFIGURED });
    renderSurface(client, 'ws_test');
    // Load-bearing: the raw-key assertion is an ABSENCE assertion, and a loading skeleton satisfies
    // it for the wrong reason. Without this anchor the test could stay green with the null handling
    // it exists to prove completely broken.
    const panel = await loadedProfileBody();

    // F-09: an unconfigured workspace is asked ONCE, here, with the Swiss default pre-selected; the
    // badge (a fact about a stored method) has nothing to show yet and does not render.
    expect(within(panel).getByRole('combobox', { name: 'MWST-Methode' })).toHaveTextContent('MWST-pflichtig, effektive Methode');
    expect(screen.queryByText('MWST-Methode: Effektiv')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/company\.vat/);
    const i18nComplaints = errors.mock.calls.filter((c) => String(c[0]).includes('[i18n]'));
    expect(i18nComplaints).toHaveLength(0);
    errors.mockRestore();
  });
});

describe('CompanyProfile: the Arbeitsbereiche panel (D24, variant B)', () => {
  it('the loaded face lists the workspaces with the Aktiv chip on the active row', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    renderSurface(client, 'ws_1');
    const panel = (await screen.findByRole('region', { name: 'Arbeitsbereiche' })) as HTMLElement;

    expect(await within(panel).findAllByRole('listitem')).toHaveLength(3);
    const active = within(panel).getByRole('button', { name: 'Arbeitsbereich Muster Grafik öffnen' });
    expect(within(active).getByText('Aktiv')).toBeInTheDocument();
    expect(within(panel).getAllByText('Aktiv')).toHaveLength(1);
  });

  it('the footer discloses the surface’s ONE create form and keeps the accent budget honest', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    const { container } = renderSurface(client, 'ws_1');
    // Settled, because this test also counts primaries over the whole container below.
    const panel = await settledWorkspacesPanel();

    expect(screen.queryByLabelText('Firmenname', { selector: 'input' })).not.toBeNull(); // profile form
    await userEvent.click(within(panel).getByRole('button', { name: 'Neuer Arbeitsbereich' }));

    // The disclosed form is the same create affordance: name field plus the create submit.
    const createRegion = (await screen.findByRole('region', { name: 'Arbeitsbereich einrichten' })) as HTMLElement;
    expect(within(createRegion).getByLabelText('Firmenname')).toBeInTheDocument();
    const submit = within(createRegion).getByRole('button', { name: 'Arbeitsbereich erstellen' });
    // `.btn--secondary`, not a second solid primary (the company save already holds this surface's
    // one) and never the tinted `.btn--accent`, which only commits a money write (K-08, C2 F2).
    expect(submit).toHaveClass('btn--secondary');
    expect(submit).not.toHaveClass('btn--accent');
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(1);

    // And it is dismissable again.
    await userEvent.click(within(createRegion).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('region', { name: 'Arbeitsbereich einrichten' })).toBeNull();
  });

  it('the no-workspace face shows the panel when the engine knows workspaces', async () => {
    renderSurface(makeClient({}), null);
    const panel = (await screen.findByRole('region', { name: 'Arbeitsbereiche' })) as HTMLElement;
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    // None is active, so no row carries the chip.
    expect(within(panel).queryByText('Aktiv')).toBeNull();

    // Its footer discloses the SAME create form the call to action opens.
    await userEvent.click(within(panel).getByRole('button', { name: 'Neuer Arbeitsbereich' }));
    expect(screen.getByLabelText('Firmenname')).toBeInTheDocument();
  });

  it('the no-workspace face hides the panel while the engine lists none', async () => {
    // A NEGATIVE assertion needs its anchor more than a positive one does, and can borrow less from
    // the DOM: on this face the panel renders `null` both while `list_workspaces` is out and once it
    // has answered with an empty list, so "the region is absent" is true of both. Anchored on the
    // heading and a bare `act` flush this test passed with the read hung forever, which means it did
    // not distinguish "the engine listed none" from "the engine never answered": the two states it
    // exists to tell apart.
    //
    // `transport.started` is not enough either, because a hung read IS started. The signal has to be
    // the route ANSWERING, so the route is a spy: it fires only when a response is actually handed
    // back, and the `act` flush after it drains the component's `await` and its `setState`.
    const empty = { ...workspacesFixture, workspaces: [] };
    const answered = vi.fn((): RestResponse => ({ status: 200, body: recordedOk(empty) }));
    renderSurface(makeClient({ list_workspaces: answered }), null);
    await screen.findByRole('heading', { level: 1, name: 'Arbeitsbereich einrichten' });
    await waitFor(() => expect(answered).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Arbeitsbereiche' })).toBeNull();
  });

  it('the loaded face with the panel has no axe violations', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    const { container } = renderSurface(client, 'ws_1');
    // The panel is the whole subject of this test, so auditing it before its own read answered
    // would audit three skeleton bars. Settled, and nothing left in flight.
    await settledWorkspacesPanel();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('CompanyProfile: custom fields (spec 6b)', () => {
  // The panel must say the CAPABILITY does not exist, not that this workspace happens to have none.
  // `getCompanyProfile` never returns `customFields` (the G-cluster that defines them is Wave 10), so
  // the panel is empty for every workspace, always. The old copy, "keine eigenen Felder definiert",
  // read as a state the operator could change and invited a hunt for a button that is not there.
  it('says custom fields do not exist yet, rather than reporting none defined', async () => {
    const client = makeClient({ get_company_profile: FULL_PROFILE });
    renderSurface(client, 'ws_test');
    // The custom-fields panel is part of the loaded body, so the read has to have answered.
    await loadedProfileBody();
    expect(
      screen.getByText('Eigene Felder gibt es noch nicht. Sobald du welche anlegen kannst, erscheinen sie hier.'),
    ).toBeInTheDocument();
  });
});
