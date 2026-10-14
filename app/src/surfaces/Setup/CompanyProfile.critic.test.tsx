/**
 * The non-author critic's probes for the D152 one-Speichern Firmenprofil (critic commit 04bb5d58),
 * adapted to assert the FIXED behaviour.
 *
 * The critic rendered the branch surface beside a verbatim copy of the f10adddd surface against one
 * stateful fake engine and compared the writes. That copy is not landed: the payloads it produced are
 * pinned here as literal values instead (captured from the old tree on 03.10.2026), so a later change
 * to any verb's payload fails by value rather than by comparison with code that no longer exists.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { recordedOk } from '../../lib/test-support';
import { CompanyProfile } from './CompanyProfile';
import workspacesFixture from './workspaces.fixture.json';

const READS = new Set(['get_company_profile', 'get_ebill_config', 'list_workspaces', 'whoami']);
const PLAIN_IBAN = 'CH9300762011623852957';

/** A fresh Studio-created workspace, exactly as `getCompanyProfile` answers it (create_workspace stores legalForm). */
function freshProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'ws_test',
    name: 'Mara Design GmbH',
    legalForm: 'gmbh',
    baseCurrency: 'CHF',
    fiscalYearStart: '01-01',
    vatMethod: null,
    vatAccounting: null,
    creditorName: null,
    creditorAddress: null,
    creditorIban: null,
    uid: null,
    mwstNo: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ledgerLocked: false,
    ...over,
  };
}

interface FakeEngine {
  client: TillClient;
  writes: { verb: string; input: Record<string, unknown> }[];
  profile: Record<string, unknown>;
}

/**
 * A small stateful engine: writes mutate the stored profile the way the real verbs do (an omitted
 * IBAN, UID, MWST-Nr or issuer name keeps the stored one, `vat_configure` stores the method), so a
 * re-read after a save returns what really landed. `fail` decides per call whether a verb refuses.
 */
function fakeEngine(profile: Record<string, unknown>, fail: (verb: string, n: number) => string | null = () => null): FakeEngine {
  const writes: FakeEngine['writes'] = [];
  const counts: Record<string, number> = {};
  const state = { ...profile };
  const transport: Transport = async (action, input) => {
    const i = input as Record<string, unknown>;
    if (action === 'list_workspaces') return { status: 200, body: recordedOk(workspacesFixture) };
    if (action === 'get_company_profile') return { status: 200, body: recordedOk({ ok: true, profile: { ...state } }) };
    if (action === 'get_ebill_config') return { status: 200, body: recordedOk({ ok: true, config: null }) };
    if (READS.has(action)) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    writes.push({ verb: action, input: i });
    counts[action] = (counts[action] ?? 0) + 1;
    const refusal = fail(action, counts[action] ?? 1);
    if (refusal !== null) return { status: 422, body: { ok: false, error: refusal } } as RestResponse;
    if (action === 'vat_configure') {
      state.vatMethod = i.method;
      state.vatAccounting = i.timing;
    }
    if (action === 'update_company_profile') {
      for (const k of ['name', 'legalForm', 'uid', 'mwstNo']) if (i[k] !== undefined) state[k] = i[k];
    }
    if (action === 'set_creditor_profile') {
      state.creditorIban = (i.iban as string | undefined) ?? state.creditorIban;
      state.creditorName = (i.creditorName as string | undefined) ?? state.creditorName ?? state.name;
    }
    return { status: 200, body: { ok: true } } as RestResponse;
  };
  return { client: new TillClient(transport), writes, profile: state };
}

function renderWith(client: TillClient) {
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/setup']}>
            <CompanyProfile />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

async function profilePanel(): Promise<HTMLElement> {
  return (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
}

function headerActions(): HTMLElement {
  return document.querySelector('.surface-header-actions') as HTMLElement;
}

function save(): HTMLElement {
  return screen.getByRole('button', { name: 'Speichern' });
}

/** The Arbeitsbereiche rows, so no read is left in flight at teardown. */
async function settled(): Promise<void> {
  const panel = (await screen.findByRole('region', { name: 'Arbeitsbereiche' })) as HTMLElement;
  await within(panel).findAllByRole('listitem');
}

const verbs = (e: FakeEngine) => e.writes.map((w) => w.verb);

/** The payloads f10adddd sent on a first save, captured from that tree and pinned by value. */
const VAT_CONFIGURE = { workspaceId: 'ws_test', method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'profile-vat-ws_test-effektiv-soll' };
const VAT_SEED = { workspaceId: 'ws_test', idempotencyKey: 'profile-vat-seed-ws_test' };
const CREDITOR_IBAN_ONLY = { workspaceId: 'ws_test', address: { street: '', buildingNo: '', zip: '', town: '', country: '' }, iban: PLAIN_IBAN };

describe('critic probe: first save on a fresh workspace', () => {
  it('IBAN only: the dirty parts are written with the f10adddd payloads, and the unchanged identity is not', async () => {
    const e = fakeEngine(freshProfile());
    renderWith(e.client);
    await userEvent.click(within(await profilePanel()).getByLabelText('IBAN für deine Rechnungen'));
    await userEvent.paste(PLAIN_IBAN);
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    // f10adddd also sent update_company_profile with the stored values; nothing in it was dirty.
    expect(e.writes).toEqual([
      { verb: 'vat_configure', input: VAT_CONFIGURE },
      { verb: 'vat_seed_defaults', input: VAT_SEED },
      { verb: 'set_creditor_profile', input: CREDITOR_IBAN_ONLY },
    ]);
    await settled();
  });

  it('a legacy workspace with NO stored legal form writes the same four verbs and payloads as f10adddd', async () => {
    const e = fakeEngine(freshProfile({ legalForm: null }));
    renderWith(e.client);
    await userEvent.click(within(await profilePanel()).getByLabelText('IBAN für deine Rechnungen'));
    await userEvent.paste(PLAIN_IBAN);
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(e.writes).toEqual([
      { verb: 'update_company_profile', input: { workspaceId: 'ws_test', name: 'Mara Design GmbH', legalForm: 'gmbh' } },
      { verb: 'vat_configure', input: VAT_CONFIGURE },
      { verb: 'vat_seed_defaults', input: VAT_SEED },
      { verb: 'set_creditor_profile', input: CREDITOR_IBAN_ONLY },
    ]);
    await settled();
  });

  it('a full first save (name, currency, address, IBAN) writes the same verbs, payloads and order as f10adddd', async () => {
    const e = fakeEngine(freshProfile());
    renderWith(e.client);
    const panel = await profilePanel();
    const nameField = within(panel).getByLabelText('Firmenname');
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Mara Design Studio GmbH');
    await userEvent.click(within(panel).getByLabelText('IBAN für deine Rechnungen'));
    await userEvent.paste(PLAIN_IBAN);
    const issuer = within(panel).getByRole('button', { name: /^Rechnungssteller/ });
    if (issuer.getAttribute('aria-expanded') !== 'true') await userEvent.click(issuer);
    await userEvent.type(within(panel).getByLabelText('Strasse'), 'Bahnhofstrasse');
    await userEvent.type(within(panel).getByLabelText('Haus-Nr.'), '1');
    await userEvent.type(within(panel).getByLabelText('PLZ'), '8001');
    await userEvent.type(within(panel).getByLabelText('Ort'), 'Zürich');
    const more = within(panel).getByRole('button', { name: 'Weitere Angaben' });
    if (more.getAttribute('aria-expanded') !== 'true') await userEvent.click(more);
    const cur = within(panel).getByLabelText('Basiswährung');
    await userEvent.clear(cur);
    await userEvent.type(cur, 'EUR');
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(e.writes).toEqual([
      { verb: 'update_company_profile', input: { workspaceId: 'ws_test', name: 'Mara Design Studio GmbH', legalForm: 'gmbh' } },
      { verb: 'set_fiscal_config', input: { workspaceId: 'ws_test', baseCurrency: 'EUR', fiscalYearStart: '01-01' } },
      { verb: 'vat_configure', input: VAT_CONFIGURE },
      { verb: 'vat_seed_defaults', input: VAT_SEED },
      {
        verb: 'set_creditor_profile',
        input: { workspaceId: 'ws_test', address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' }, iban: PLAIN_IBAN },
      },
    ]);
    await settled();
  });
});

describe('critic probe: VAT seed failure and retry (the FAIL finding)', () => {
  const seedFailsOnce = (verb: string, n: number) => (verb === 'vat_seed_defaults' && n === 1 ? 'internal_error' : null);

  it('after vat_seed_defaults fails, MWST stays dirty: the next Speichern re-runs the seed alone, then says Gespeichert', async () => {
    const e = fakeEngine(freshProfile(), seedFailsOnce);
    renderWith(e.client);
    await userEvent.click(within(await profilePanel()).getByLabelText('IBAN für deine Rechnungen'));
    await userEvent.paste(PLAIN_IBAN);
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Nicht gespeichert: MWST')).toBeInTheDocument();
    expect(screen.getByText(/liess sich nicht einrichten/)).toBeInTheDocument();

    // The page re-read the profile (vat_configure landed), so the MWST select has given way to the badge.
    expect(await screen.findByText('MWST-Methode: Effektiv')).toBeInTheDocument();
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(verbs(e)).toEqual(['vat_configure', 'vat_seed_defaults', 'set_creditor_profile', 'vat_seed_defaults']);
    // The retry is the same idempotent seed, and the method is not configured twice.
    expect(e.writes[3]?.input).toEqual(VAT_SEED);
    expect(screen.queryByText(/liess sich nicht einrichten/)).toBeNull();

    // Now nothing is dirty: a third Speichern writes nothing.
    await userEvent.click(save());
    await waitFor(() => expect(within(headerActions()).getByText('Gespeichert')).toBeInTheDocument());
    expect(e.writes).toHaveLength(4);
    await settled();
  });
});

describe('critic probe: a stored value cleared to blank is refused, never a false Gespeichert', () => {
  it('a cleared stored IBAN: no write, the part stays dirty, the field says the way out', async () => {
    const e = fakeEngine(freshProfile({ vatMethod: 'effektiv', vatAccounting: 'soll', creditorIban: PLAIN_IBAN, creditorName: 'Mara Design GmbH' }));
    renderWith(e.client);
    const panel = await profilePanel();
    const iban = within(panel).getByLabelText('IBAN für deine Rechnungen');
    await userEvent.clear(iban);
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Nicht gespeichert: Rechnungssteller')).toBeInTheDocument();
    expect(within(panel).getByRole('alert')).toHaveTextContent('Die IBAN lässt sich hier nicht entfernen. Trag eine andere IBAN ein oder behalte die bisherige.');
    expect(iban).toHaveAttribute('aria-invalid', 'true');
    expect(e.writes).toEqual([]);
    expect(e.profile.creditorIban).toBe(PLAIN_IBAN);

    // Still dirty: Speichern refuses again rather than reporting the old value as saved.
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Nicht gespeichert: Rechnungssteller')).toBeInTheDocument();
    // The way out: keep the stored IBAN, and the part is clean again.
    await userEvent.click(iban);
    await userEvent.paste(PLAIN_IBAN);
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(e.writes).toEqual([]);
    expect(within(panel).queryByRole('alert')).toBeNull();
    await settled();
  });

  it('a cleared stored UID and MWST-Nr with nothing else changed: no write, each field says the way out', async () => {
    const e = fakeEngine(freshProfile({ vatMethod: 'effektiv', vatAccounting: 'soll', uid: 'CHE-123.456.789', mwstNo: 'CHE-123.456.789 MWST' }));
    renderWith(e.client);
    const panel = await profilePanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'Weitere Angaben' }));
    await userEvent.clear(within(panel).getByLabelText('UID'));
    await userEvent.clear(within(panel).getByLabelText('MWST-Nummer'));
    await userEvent.click(save());
    // The header names the two held-back fields, not the whole Firmenangaben part.
    expect(await within(headerActions()).findByText('Nicht gespeichert: UID, MWST-Nummer')).toBeInTheDocument();
    expect(within(panel).getByText('Die UID lässt sich hier nicht entfernen. Trag die richtige UID ein oder behalte die bisherige.')).toBeInTheDocument();
    expect(within(panel).getByText(/Die MWST-Nummer lässt sich hier nicht entfernen/)).toBeInTheDocument();
    expect(within(panel).getByLabelText('UID')).toHaveAccessibleDescription(/Die UID lässt sich hier nicht entfernen/);
    expect(within(panel).getByLabelText('MWST-Nummer')).toHaveAccessibleDescription(
      'Die MWST-Nummer lässt sich hier nicht entfernen. Trag die richtige Nummer ein oder behalte die bisherige.',
    );
    expect(within(panel).getByLabelText('MWST-Nummer')).toHaveAttribute('aria-invalid', 'true');
    expect(e.writes).toEqual([]);
    expect(e.profile.uid).toBe('CHE-123.456.789');
    await settled();
  });

  it('a cleared UID holds back only itself: a rename in the same Speichern lands, without a uid key', async () => {
    const e = fakeEngine(freshProfile({ vatMethod: 'effektiv', vatAccounting: 'soll', uid: 'CHE-123.456.789' }));
    renderWith(e.client);
    const panel = await profilePanel();
    const nameField = within(panel).getByLabelText('Firmenname');
    await userEvent.clear(nameField);
    await userEvent.paste('Mara Design Studio GmbH');
    await userEvent.click(within(panel).getByRole('button', { name: 'Weitere Angaben' }));
    const uidField = within(panel).getByLabelText('UID');
    await userEvent.clear(uidField);
    await userEvent.click(save());

    // Only the UID is named as not saved; the rename is written, with no uid key, so the engine keeps it.
    expect(await within(headerActions()).findByText('Nicht gespeichert: UID')).toBeInTheDocument();
    expect(e.writes).toEqual([
      { verb: 'update_company_profile', input: { workspaceId: 'ws_test', name: 'Mara Design Studio GmbH', legalForm: 'gmbh' } },
    ]);
    expect(e.profile.name).toBe('Mara Design Studio GmbH');
    expect(e.profile.uid).toBe('CHE-123.456.789');
    expect(uidField).toHaveAccessibleDescription(/Die UID lässt sich hier nicht entfernen/);

    // The UID stays dirty: Speichern refuses it again and does not resend the rename.
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Nicht gespeichert: UID')).toBeInTheDocument();
    expect(e.writes).toHaveLength(1);

    // Restoring the stored UID makes identity clean: the next Speichern writes nothing and says so.
    await userEvent.click(uidField);
    await userEvent.paste('CHE-123.456.789');
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(e.writes).toHaveLength(1);
    expect(within(panel).queryByText(/Die UID lässt sich hier nicht entfernen/)).toBeNull();
    await settled();
  });

  it('a cleared distinct issuer name: no write, the field says the way out, the summary keeps the stored issuer', async () => {
    const e = fakeEngine(
      freshProfile({
        vatMethod: 'effektiv',
        vatAccounting: 'soll',
        creditorIban: PLAIN_IBAN,
        creditorName: 'Mara Druck AG',
        creditorAddress: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      }),
    );
    renderWith(e.client);
    const panel = await profilePanel();
    // Differs from the Firmenname, so the block is open on load.
    await userEvent.clear(within(panel).getByLabelText('Name Rechnungssteller'));
    const toggle = within(panel).getByRole('button', { name: /^Rechnungssteller/ });
    await userEvent.click(toggle);
    // Closed, the line names what the engine stores, never the draft's "wie Firmenname".
    expect(toggle).toHaveTextContent('Rechnungssteller: Mara Druck AG · Bahnhofstrasse 1, 8001 Zürich');
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Nicht gespeichert: Rechnungssteller')).toBeInTheDocument();
    // The refusal opens the block, so the message is in sight.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByLabelText('Name Rechnungssteller')).toHaveAccessibleDescription(
      'Den Namen des Rechnungsstellers kannst du hier nicht leeren. Trag den Firmennamen ein oder behalte den bisherigen Namen.',
    );
    expect(e.writes).toEqual([]);
    expect(e.profile.creditorName).toBe('Mara Druck AG');

    // The way out the message names: the Firmenname. It is written, and the summary follows the store.
    await userEvent.type(within(panel).getByLabelText('Name Rechnungssteller'), 'Mara Design GmbH');
    await userEvent.click(save());
    expect(await within(headerActions()).findByText('Gespeichert')).toBeInTheDocument();
    expect(e.writes[0]?.input).toEqual(expect.objectContaining({ creditorName: 'Mara Design GmbH' }));
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveTextContent('Rechnungssteller: wie Firmenname · Bahnhofstrasse 1, 8001 Zürich'));
    await settled();
  });
});

describe('critic probe: the closed issuer summary', () => {
  it('a Liechtenstein address with an equal name: the summary names the country', async () => {
    const e = fakeEngine(
      freshProfile({
        vatMethod: 'effektiv',
        vatAccounting: 'soll',
        creditorIban: PLAIN_IBAN,
        creditorName: 'Mara Design GmbH',
        creditorAddress: { street: 'Städtle', buildingNo: '1', zip: '9490', town: 'Vaduz', country: 'LI' },
      }),
    );
    renderWith(e.client);
    const toggle = within(await profilePanel()).getByRole('button', { name: /^Rechnungssteller/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Rechnungssteller: wie Firmenname · Städtle 1, 9490 Vaduz, LI');
    await settled();
  });

  it('a Swiss address carries no country code', async () => {
    const e = fakeEngine(
      freshProfile({
        vatMethod: 'effektiv',
        vatAccounting: 'soll',
        creditorName: null,
        creditorAddress: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      }),
    );
    renderWith(e.client);
    const toggle = within(await profilePanel()).getByRole('button', { name: /^Rechnungssteller/ });
    expect(toggle.textContent).toBe('Rechnungssteller: wie Firmenname · Bahnhofstrasse 1, 8001 Zürich');
    await settled();
  });
});
